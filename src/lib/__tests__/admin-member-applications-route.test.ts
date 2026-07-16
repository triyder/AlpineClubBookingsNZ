import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  memberApplicationFindMany: vi.fn(),
  memberApplicationCount: vi.fn(),
  nominationTokenFindMany: vi.fn(),
  memberFindMany: vi.fn(),
  parseApplicationAddress: vi.fn(),
  parseApplicationFamilyMembers: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    memberApplication: {
      findMany: mocks.memberApplicationFindMany,
      count: mocks.memberApplicationCount,
    },
    nominationToken: {
      findMany: mocks.nominationTokenFindMany,
    },
    member: {
      findMany: mocks.memberFindMany,
    },
  },
}));

vi.mock("@/lib/nomination", () => ({
  parseApplicationAddress: mocks.parseApplicationAddress,
  parseApplicationFamilyMembers: mocks.parseApplicationFamilyMembers,
}));

import { GET } from "@/app/api/admin/member-applications/route";

describe("GET /api/admin/member-applications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.memberApplicationFindMany.mockResolvedValue([]);
    mocks.memberApplicationCount.mockResolvedValue(0);
    mocks.nominationTokenFindMany.mockResolvedValue([]);
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.parseApplicationAddress.mockImplementation((value) => value);
    mocks.parseApplicationFamilyMembers.mockImplementation((value) => value);
  });

  it("blocks deactivated admin sessions", async () => {
    mocks.requireActiveSessionUser.mockResolvedValue(
      NextResponse.json({ error: "Account is deactivated" }, { status: 403 })
    );

    const response = await GET(
      new NextRequest("http://localhost/api/admin/member-applications")
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Account is deactivated",
    });
    expect(mocks.memberApplicationFindMany).not.toHaveBeenCalled();
  });

  it("returns an empty queue for active admins", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/admin/member-applications")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [],
      applications: [],
      pendingCount: 0,
      page: 1,
      pageSize: 25,
      total: 0,
    });
    expect(mocks.requireActiveSessionUser).toHaveBeenCalledWith("admin-1");
    expect(mocks.memberApplicationFindMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      where: undefined,
      take: 25,
      skip: 0,
    });
    expect(mocks.memberApplicationCount).toHaveBeenCalledWith({ where: undefined });
    expect(mocks.memberApplicationCount).toHaveBeenCalledWith({
      where: { status: "PENDING_ADMIN" },
    });
    expect(mocks.memberFindMany).not.toHaveBeenCalled();
  });

  it("decorates waiting applications with pending nomination token status", async () => {
    mocks.memberApplicationFindMany.mockResolvedValue([
      {
        id: "app-1",
        applicantFirstName: "Pat",
        applicantLastName: "Applicant",
        applicantEmail: "pat@example.com",
        applicantDateOfBirth: null,
        applicantPhone: null,
        applicantAddress: null,
        familyMembers: [],
        nominator1Email: "nom1@example.com",
        nominator2Email: "nom2@example.com",
        nominator1Id: "nom-1",
        nominator2Id: "nom-2",
        nominator1ConfirmedAt: null,
        nominator2ConfirmedAt: null,
        status: "PENDING_NOMINATORS",
        adminNotes: null,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ]);
    mocks.memberApplicationCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mocks.memberFindMany.mockResolvedValue([
      { id: "nom-1", firstName: "Nom", lastName: "One" },
      { id: "nom-2", firstName: "Nom", lastName: "Two" },
    ]);
    mocks.nominationTokenFindMany.mockResolvedValue([
      {
        id: "token-1",
        applicationId: "app-1",
        nominatorMemberId: "nom-1",
        expiresAt: new Date("2026-06-08T00:00:00.000Z"),
        reminderCount: 4,
        lastSentAt: new Date("2026-06-01T00:00:00.000Z"),
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/admin/member-applications?status=PENDING_NOMINATORS")
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applications[0]).toMatchObject({
      id: "app-1",
      nominator1Name: "Nom One",
      nominator1TokenExpiresAt: "2026-06-08T00:00:00.000Z",
      nominator1TokenLastSentAt: "2026-06-01T00:00:00.000Z",
      nominator1ReminderCount: 4,
      nominatorReminderLimit: 4,
      nominator1ReminderExhausted: true,
      nominator2ReminderExhausted: false,
    });
    expect(mocks.nominationTokenFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          applicationId: { in: ["app-1"] },
          confirmedAt: null,
        },
      })
    );
  });

  it("serialises applicantDateOfBirth as an NZ date-only string, not a full ISO datetime (#1931 HIGH-2)", async () => {
    // The approval panel passes this value verbatim into the joining-fee
    // preview endpoint, whose schema is a strict /^\d{4}-\d{2}-\d{2}$/ — a full
    // ISO datetime would 400 and the preview/prefill would silently never fire.
    // Cover both plausible storage shapes: UTC midnight and NZ midnight
    // (1990-05-14T12:00:00Z is 1990-05-15 00:00 in Pacific/Auckland, where a
    // naive .toISOString().slice(0, 10) would yield the WRONG day, 05-14).
    const base = {
      applicantFirstName: "Pat",
      applicantLastName: "Applicant",
      applicantEmail: "pat@example.com",
      applicantPhone: null,
      applicantAddress: null,
      familyMembers: [],
      nominator1Email: "nom1@example.com",
      nominator2Email: "nom2@example.com",
      nominator1Id: null,
      nominator2Id: null,
      nominator1ConfirmedAt: null,
      nominator2ConfirmedAt: null,
      status: "PENDING_ADMIN",
      adminNotes: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    mocks.memberApplicationFindMany.mockResolvedValue([
      { ...base, id: "app-utc", applicantDateOfBirth: new Date("1990-05-15T00:00:00.000Z") },
      { ...base, id: "app-nz", applicantDateOfBirth: new Date("1990-05-14T12:00:00.000Z") },
    ]);
    mocks.memberApplicationCount.mockResolvedValueOnce(2).mockResolvedValueOnce(2);

    const response = await GET(
      new NextRequest("http://localhost/api/admin/member-applications")
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const dobById = new Map(
      body.applications.map((app: { id: string; applicantDateOfBirth: string }) => [
        app.id,
        app.applicantDateOfBirth,
      ]),
    );
    expect(dobById.get("app-utc")).toBe("1990-05-15");
    expect(dobById.get("app-nz")).toBe("1990-05-15");
  });
});
