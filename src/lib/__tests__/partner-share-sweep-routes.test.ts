// Route-level wiring tests for issue #1756: member deactivation (member edit,
// bulk update, account-deletion anonymisation) and an ADULT→minor tier
// correction must sweep the member's FUTURE shared double-bed second-occupant
// allocations back to the awaiting-allocation queue and alert admins. The
// REAL sweep helper (bed-allocation-lifecycle.ts) runs here against a mocked
// Prisma so the query/delete wiring is exercised end-to-end; the helper's own
// edge cases live in bed-allocation-lifecycle.test.ts and the dissolve paths
// in member-partner-link.test.ts. Mock harness mirrors
// admin-account-guards-routes.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    deletionRequest: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    booking: { findMany: vi.fn().mockResolvedValue([]) },
    bookingGuest: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    accessRoleDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    memberAccessRole: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    familyGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    bedAllocation: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    xeroContactCache: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  syncManagedXeroContactGroupForMember: vi.fn(),
  updateXeroContact: vi.fn(),
}));
vi.mock("@/lib/booking-cancel", () => ({
  cancelBooking: vi.fn().mockResolvedValue({ status: 200 }),
}));
vi.mock("@/lib/email", () => ({
  sendAccountDeletionApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendAccountDeletionRejectedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPartnerShareSweptAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditEmailDomain: vi.fn(() => null),
  getAuditRequestContext: vi.fn(() => ({ ipAddress: "127.0.0.1" })),
  createAuditLog: vi.fn(),
  logAudit: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import { sendAdminPartnerShareSweptAlert } from "@/lib/email";
import { PUT as updateMember } from "@/app/api/admin/members/[id]/route";
import { POST as bulkUpdate } from "@/app/api/admin/members/bulk-update/route";
import { POST as reviewDeletion } from "@/app/api/admin/deletion-requests/[id]/route";

const fullAdminGuard = {
  ok: true,
  session: { user: { id: "actor1", role: "ADMIN", accessRoles: ["ADMIN"] } },
};

const userTarget = {
  id: "user2",
  firstName: "Uma",
  lastName: "User",
  email: "uma@test.com",
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  dateOfBirth: null,
  role: "USER",
  financeAccessLevel: "NONE",
  accessRoles: [{ role: "USER" }],
  ageTier: "ADULT",
  active: true,
  forcePasswordChange: false,
  canLogin: true,
  cancelledAt: null,
  archivedAt: null,
  xeroContactId: null,
  joinedDate: null,
  createdAt: new Date("2025-01-01"),
};

const FUTURE_NIGHT = new Date("2026-08-01T00:00:00.000Z");

// Uma is the second occupant of a double whose primary is her (now ex-)
// partner Piotr, on another booking.
const umaSecondOccupantRow = {
  id: "alloc-uma-2nd",
  bookingId: "booking-uma",
  bookingGuestId: "guest-uma",
  bedId: "bed-double",
  roomId: "room-1",
  stayDate: FUTURE_NIGHT,
  bookingGuest: { memberId: "user2", firstName: "Uma", lastName: "User" },
};
const piotrPrimaryRow = {
  id: "alloc-piotr-primary",
  bookingId: "booking-piotr",
  bookingGuestId: "guest-piotr",
  bedId: "bed-double",
  roomId: "room-1",
  stayDate: FUTURE_NIGHT,
  bookingGuest: { memberId: "member-p", firstName: "Piotr", lastName: "Pine" },
};

/** Serve the sweep's queries: Uma is a second occupant; Piotr her primary. */
function mockSharedDoubleForUser2() {
  vi.mocked(prisma.bedAllocation.findMany).mockImplementation((async (args: {
    where?: { isSecondOccupant?: boolean; OR?: unknown };
  }) => {
    const where = args?.where ?? {};
    if (where.isSecondOccupant === true) return [umaSecondOccupantRow];
    if (where.isSecondOccupant === false && where.OR) return [piotrPrimaryRow];
    return [];
  }) as never);
  vi.mocked(prisma.bedAllocation.deleteMany).mockResolvedValue({ count: 1 } as never);
}

function jsonRequest(url: string, body: Record<string, unknown>, method = "POST") {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function putMember(id: string, body: Record<string, unknown>) {
  return updateMember(
    jsonRequest(`http://localhost/api/admin/members/${id}`, body, "PUT"),
    { params: Promise.resolve({ id }) },
  );
}

function mockTransaction() {
  vi.mocked(prisma.$transaction).mockImplementation((async (op: any) =>
    op({
      member: {
        update: prisma.member.update,
        updateMany: prisma.member.updateMany,
        count: prisma.member.count,
      },
      memberAccessRole: {
        createMany: prisma.memberAccessRole.createMany,
        deleteMany: prisma.memberAccessRole.deleteMany,
      },
      familyGroupMember: { deleteMany: prisma.familyGroupMember.deleteMany },
      bookingGuest: { updateMany: prisma.bookingGuest.updateMany },
      bedAllocation: prisma.bedAllocation,
      deletionRequest: { update: prisma.deletionRequest.update },
      auditLog: { create: prisma.auditLog.create },
    })) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(fullAdminGuard);
  vi.mocked(prisma.member.count).mockResolvedValue(0);
  vi.mocked(prisma.booking.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.bedAllocation.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.bedAllocation.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.member.update).mockResolvedValue({
    ...userTarget,
    active: false,
  } as never);
  mockTransaction();
});

describe("#1756 member edit deactivate — PUT /api/admin/members/[id]", () => {
  it("sweeps the member's future shared-double placement and alerts admins", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(userTarget as never);
    mockSharedDoubleForUser2();

    const res = await putMember("user2", { active: false });

    expect(res.status).toBe(200);
    expect(prisma.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-uma-2nd"] }, isSecondOccupant: true },
    });
    // Both bookings audited by the sweep.
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BED_ALLOCATION_PARTNER_SHARE_SWEPT",
        entityId: "booking-uma",
      }),
      expect.anything(),
    );
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BED_ALLOCATION_PARTNER_SHARE_SWEPT",
        entityId: "booking-piotr",
      }),
      expect.anything(),
    );
    expect(sendAdminPartnerShareSweptAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Uma User",
        partnerName: "Piotr Pine",
        reason: "Member deactivated",
        nights: [FUTURE_NIGHT],
      }),
    );
  });

  it("sweeps on an ADULT → minor tier correction (same defect class)", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(userTarget as never);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...userTarget,
      ageTier: "YOUTH",
    } as never);
    mockSharedDoubleForUser2();

    const res = await putMember("user2", { ageTier: "YOUTH" });

    expect(res.status).toBe(200);
    expect(prisma.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-uma-2nd"] }, isSecondOccupant: true },
    });
    expect(sendAdminPartnerShareSweptAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Member is no longer an adult" }),
    );
  });

  it("does not touch allocations on an edit that neither deactivates nor re-tiers", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(userTarget as never);
    vi.mocked(prisma.member.update).mockResolvedValue(userTarget as never);

    const res = await putMember("user2", { firstName: "Uma", active: true });

    expect(res.status).toBe(200);
    expect(prisma.bedAllocation.findMany).not.toHaveBeenCalled();
    expect(prisma.bedAllocation.deleteMany).not.toHaveBeenCalled();
    expect(sendAdminPartnerShareSweptAlert).not.toHaveBeenCalled();
  });
});

describe("#1756 bulk deactivate — POST /api/admin/members/bulk-update", () => {
  it("sweeps each deactivated member's shared placements and alerts admins", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([userTarget] as never);
    // Another Full Admin survives the set.
    vi.mocked(prisma.member.count).mockResolvedValue(2 as never);
    vi.mocked(prisma.member.updateMany).mockResolvedValue({ count: 1 } as never);
    mockSharedDoubleForUser2();

    const res = await bulkUpdate(
      jsonRequest("http://localhost/api/admin/members/bulk-update", {
        ids: ["user2"],
        action: "deactivate",
      }),
    );

    expect(res.status).toBe(200);
    expect(prisma.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-uma-2nd"] }, isSecondOccupant: true },
    });
    expect(sendAdminPartnerShareSweptAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Uma User",
        partnerName: "Piotr Pine",
        reason: "Member deactivated",
      }),
    );
  });

  it("does not sweep on reactivate", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      { ...userTarget, active: false },
    ] as never);
    vi.mocked(prisma.member.updateMany).mockResolvedValue({ count: 1 } as never);

    const res = await bulkUpdate(
      jsonRequest("http://localhost/api/admin/members/bulk-update", {
        ids: ["user2"],
        action: "reactivate",
      }),
    );

    expect(res.status).toBe(200);
    expect(prisma.bedAllocation.findMany).not.toHaveBeenCalled();
    expect(sendAdminPartnerShareSweptAlert).not.toHaveBeenCalled();
  });
});

describe("#1756 deletion approval — POST /api/admin/deletion-requests/[id]", () => {
  it("sweeps BEFORE the guest rows are anonymised, and alerts with the pre-anonymisation name", async () => {
    vi.mocked(prisma.deletionRequest.findUnique).mockResolvedValue({
      id: "dr1",
      status: "PENDING",
      member: userTarget,
    } as never);
    mockSharedDoubleForUser2();

    const res = await reviewDeletion(
      jsonRequest("http://localhost/api/admin/deletion-requests/dr1", {
        action: "approve",
      }),
      { params: Promise.resolve({ id: "dr1" }) },
    );

    expect(res.status).toBe(200);
    expect(prisma.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-uma-2nd"] }, isSecondOccupant: true },
    });
    // The sweep must read bookingGuest.memberId before step 5 nulls it.
    const sweepOrder =
      vi.mocked(prisma.bedAllocation.deleteMany).mock.invocationCallOrder[0];
    const anonymiseOrder =
      vi.mocked(prisma.bookingGuest.updateMany).mock.invocationCallOrder[0];
    expect(sweepOrder).toBeLessThan(anonymiseOrder);
    expect(sendAdminPartnerShareSweptAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Uma User",
        partnerName: "Piotr Pine",
        reason: "Member deactivated",
      }),
    );
  });
});
