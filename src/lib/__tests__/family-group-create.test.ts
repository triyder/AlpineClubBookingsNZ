import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    familyGroup: { create: vi.fn(), findUnique: vi.fn() },
    familyGroupJoinRequest: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { familyGroupJoinRequest: {} },
}));
vi.mock("@/lib/email", () => ({
  sendGroupCreateRequestConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminFamilyGroupRequestAlert: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { applyRateLimit } from "@/lib/rate-limit";
import {
  sendGroupCreateRequestConfirmationEmail,
  sendAdminFamilyGroupRequestAlert,
} from "@/lib/email";
import { POST as createGroup } from "@/app/api/members/family/create-group/route";

const mockedAuth = vi.mocked(auth);

const adultSession = { user: { id: "adult1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any;

const CHILD_DOB = "2018-03-15";
const ADULT_DOB = "1990-03-15";

function groupLessRequester(overrides: Record<string, unknown> = {}) {
  return {
    id: "adult1",
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@test.com",
    active: true,
    canLogin: true,
    ageTier: "ADULT",
    familyGroupMemberships: [],
    ...overrides,
  };
}

function nextYearDateOnly() {
  return `${new Date().getUTCFullYear() + 1}-01-01`;
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/members/family/create-group", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/** Wire the transaction mock: memberless group + sequential request rows. */
function mockTransaction() {
  const txGroupCreate = vi.fn().mockImplementation(async ({ data }: any) => ({
    id: "fg-new",
    ...data,
  }));
  let requestCounter = 0;
  const txRequestCreate = vi.fn().mockImplementation(async ({ data }: any) => ({
    id: `req-${++requestCounter}`,
    ...data,
  }));
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
    fn({
      familyGroup: { create: txGroupCreate },
      familyGroupJoinRequest: { create: txRequestCreate },
    })
  );
  return { txGroupCreate, txRequestCreate };
}

describe("POST /api/members/family/create-group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(applyRateLimit).mockResolvedValue(null as any);
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(401);
  });

  it("returns 403 for inactive member (session guard)", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    mockRequireActiveSessionUser.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Account is deactivated" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(403);
  });

  it("returns the rate-limit response when the bucket rejects", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(applyRateLimit).mockResolvedValueOnce(
      NextResponse.json({ error: "Too many requests" }, { status: 429 }) as any
    );

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(429);
    expect(prisma.member.findUnique).not.toHaveBeenCalled();
  });

  it("rejects non-adult requesters", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      groupLessRequester({ ageTier: "YOUTH" }) as any
    );

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/only adults/i);
  });

  it("rejects requesters without a login account", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      groupLessRequester({ canLogin: false }) as any
    );

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/login accounts/i);
  });

  it("rejects requesters already in a family group", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      groupLessRequester({ familyGroupMemberships: [{ familyGroupId: "g1" }] }) as any
    );

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/already in a family group/i);
  });

  it("rejects when a GROUP_CREATE request is already pending", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue({
      id: "existing",
      type: "GROUP_CREATE",
    } as any);

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/pending family group creation request/i);
  });

  it("rejects when a JOIN_REQUEST is already pending", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue({
      id: "existing",
      type: "JOIN_REQUEST",
    } as any);

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/pending join request/i);
  });

  it("returns 404 with the invite-route message for an unregistered partner", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);

    const res = await createGroup(makeRequest({ partnerEmail: "ghost@test.com" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe(
      "This person is not a registered member. They need to join through the membership process first. Contact admin if you believe they should be a member."
    );
  });

  it("rejects a non-adult partner", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "youth1",
      firstName: "Kid",
      lastName: "Smith",
      ageTier: "YOUTH",
    } as any);

    const res = await createGroup(makeRequest({ partnerEmail: "kid@test.com" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/only adults can be invited/i);
  });

  it("rejects the requester naming themselves as partner", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "adult1",
      firstName: "Alice",
      lastName: "Smith",
      ageTier: "ADULT",
    } as any);

    const res = await createGroup(makeRequest({ partnerEmail: "alice@test.com" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/yourself/i);
  });

  it("rejects an impossible child date of birth", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);

    const res = await createGroup(
      makeRequest({
        children: [{ firstName: "Sam", lastName: "Smith", dateOfBirth: "2026-02-31" }],
      })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/real calendar date/i);
  });

  it("rejects a future child date of birth", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);

    const res = await createGroup(
      makeRequest({
        children: [{ firstName: "Sam", lastName: "Smith", dateOfBirth: nextYearDateOnly() }],
      })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/future/i);
  });

  it("rejects a child date of birth computing to the adult tier", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);

    const res = await createGroup(
      makeRequest({
        children: [{ firstName: "Sam", lastName: "Smith", dateOfBirth: ADULT_DOB }],
      })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/adult request flow/i);
  });

  it("rejects more than 6 children", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    const child = { firstName: "Sam", lastName: "Smith", dateOfBirth: CHILD_DOB };
    const res = await createGroup(makeRequest({ children: Array(7).fill(child) }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/validation/i);
  });

  it("rejects duplicate child rows within one submission (case-insensitive)", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);

    const res = await createGroup(
      makeRequest({
        children: [
          { firstName: "Sam", lastName: "Smith", dateOfBirth: CHILD_DOB },
          { firstName: "sam", lastName: "SMITH", dateOfBirth: CHILD_DOB },
        ],
      })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/already included in this submission/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates memberless group + GROUP_CREATE + child requests in one transaction", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "partner1",
      firstName: "Bob",
      lastName: "Jones",
      ageTier: "ADULT",
    } as any);
    const { txGroupCreate, txRequestCreate } = mockTransaction();

    const res = await createGroup(
      makeRequest({
        groupName: "Adventure Family",
        partnerEmail: "Bob@Test.com",
        children: [
          { firstName: "Sam", lastName: "Smith", dateOfBirth: CHILD_DOB },
          { firstName: "Pip", lastName: "Smith", dateOfBirth: "2020-06-01" },
        ],
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.requestId).toBe("req-1");
    expect(body.familyGroupId).toBe("fg-new");
    expect(body.childRequestIds).toEqual(["req-2", "req-3"]);

    // Everything happens in exactly one transaction; the group is created
    // memberless (no FamilyGroupMember create anywhere in this route).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txGroupCreate).toHaveBeenCalledWith({ data: { name: "Adventure Family" } });

    // GROUP_CREATE is created first, carrying the resolved partner.
    expect(txRequestCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        familyGroupId: "fg-new",
        requesterId: "adult1",
        type: "GROUP_CREATE",
        invitedMemberId: "partner1",
      }),
    });
    expect(txRequestCreate).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        familyGroupId: "fg-new",
        requesterId: "adult1",
        type: "CHILD_REQUEST",
        childFirstName: "Sam",
        childLastName: "Smith",
        childDateOfBirth: new Date(`${CHILD_DOB}T00:00:00.000Z`),
      }),
    });
    expect(txRequestCreate).toHaveBeenNthCalledWith(3, {
      data: expect.objectContaining({
        type: "CHILD_REQUEST",
        childFirstName: "Pip",
      }),
    });

    // GROUP_CREATE floats above its children in the createdAt asc admin queue.
    const groupCreateCreatedAt = txRequestCreate.mock.calls[0][0].data.createdAt as Date;
    const firstChildCreatedAt = txRequestCreate.mock.calls[1][0].data.createdAt as Date;
    expect(groupCreateCreatedAt.getTime()).toBeLessThan(firstChildCreatedAt.getTime());

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FAMILY_GROUP_CREATE_REQUESTED",
        entityType: "FamilyGroupJoinRequest",
        entityId: "req-1",
        category: "family",
        metadata: expect.objectContaining({
          familyGroupId: "fg-new",
          groupName: "Adventure Family",
          partnerMemberId: "partner1",
          childCount: 2,
          childRequestIds: ["req-2", "req-3"],
        }),
      })
    );

    expect(sendGroupCreateRequestConfirmationEmail).toHaveBeenCalledWith(
      "alice@test.com",
      "Alice Smith",
      "Adventure Family"
    );
    expect(sendAdminFamilyGroupRequestAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestType: "Group Create Request",
        requesterName: "Alice Smith",
        groupName: "Adventure Family",
      })
    );
  });

  it("defaults the group name to '{lastName} Family' and allows no partner/children", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    const { txGroupCreate, txRequestCreate } = mockTransaction();

    const res = await createGroup(makeRequest({}));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.childRequestIds).toEqual([]);
    expect(txGroupCreate).toHaveBeenCalledWith({ data: { name: "Smith Family" } });
    expect(txRequestCreate).toHaveBeenCalledTimes(1);
    expect(txRequestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "GROUP_CREATE",
        invitedMemberId: null,
      }),
    });
    // No partner lookup when no partnerEmail was supplied.
    expect(prisma.member.findFirst).not.toHaveBeenCalled();
  });
});
