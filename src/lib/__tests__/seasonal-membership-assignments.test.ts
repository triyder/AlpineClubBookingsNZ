import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

// Best-effort Xero contact-group trigger (E8, #1934): mocked so we can assert
// it fires only for current-season changes and actually-copied candidates.
const mockTriggerGroupSync = vi.fn();
vi.mock("@/lib/xero-contact-groups", () => ({
  triggerMemberXeroContactGroupSync: (...args: unknown[]) =>
    mockTriggerGroupSync(...args),
}));

import { getSeasonYear } from "@/lib/utils";

import {
  getSeasonalMembershipChangePreview,
  rollForwardSeasonalMembershipAssignments,
  saveSeasonalMembershipAssignment,
  SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION,
  SEASONAL_MEMBERSHIP_ASSIGNMENTS_ROLLED_FORWARD_ACTION,
} from "@/lib/seasonal-membership-assignments";

const fullType = {
  id: "type-full",
  key: "FULL",
  name: "Full",
  description: "Full membership",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
  sortOrder: 0,
};

const associateType = {
  id: "type-associate",
  key: "ASSOCIATE",
  name: "Associate",
  description: "Associate membership",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "NON_MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
  sortOrder: 1,
};

const inactiveType = {
  ...associateType,
  id: "type-inactive",
  key: "INACTIVE",
  name: "Inactive",
  isActive: false,
};

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    checkIn: new Date("2099-08-01T00:00:00.000Z"),
    checkOut: new Date("2099-08-03T00:00:00.000Z"),
    status: "PAID",
    finalPriceCents: 12345,
    waitlistPosition: null,
    waitlistOfferedAt: null,
    waitlistOfferExpiresAt: null,
    _count: { guests: 2 },
    ...overrides,
  };
}

function previousAssignment() {
  return {
    id: "assignment-1",
    memberId: "member-1",
    seasonYear: 2026,
    membershipTypeId: "type-full",
    applyFrom: new Date("2026-05-15T00:00:00.000Z"),
    assignedByMemberId: "admin-old",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    membershipType: fullType,
  };
}

function makePreviewDb() {
  const confirmedBookings = [
    booking({ id: "confirmed-1", status: "PAID" }),
    booking({ id: "confirmed-2", status: "CONFIRMED" }),
  ];
  const draftBookings = [booking({ id: "draft-1", status: "DRAFT" })];
  const waitlistBookings = [
    booking({
      id: "waitlist-1",
      status: "WAITLISTED",
      waitlistPosition: 1,
    }),
  ];
  const subscriptions = [
    {
      id: "subscription-current",
      seasonYear: 2026,
      status: "PAID",
      xeroInvoiceId: "xero-invoice-id-not-returned",
      xeroInvoiceNumber: "INV-2026",
      paidAt: new Date("2026-05-01T00:00:00.000Z"),
    },
    {
      id: "subscription-old",
      seasonYear: 2025,
      status: "UNPAID",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      paidAt: null,
    },
  ];

  const db = {
    member: {
      findUnique: vi.fn().mockResolvedValue({ id: "member-1" }),
      findMany: vi.fn(),
    },
    membershipType: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.id === "type-associate") return associateType;
        if (where.id === "type-inactive") return inactiveType;
        return fullType;
      }),
    },
    seasonalMembershipAssignment: {
      findUnique: vi.fn().mockResolvedValue(previousAssignment()),
      findMany: vi.fn(),
      upsert: vi.fn().mockResolvedValue({
        ...previousAssignment(),
        id: "assignment-saved",
        membershipTypeId: "type-associate",
        assignedByMemberId: "admin-1",
        updatedAt: new Date("2026-06-02T00:00:00.000Z"),
        membershipType: associateType,
      }),
      createMany: vi.fn(),
    },
    booking: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.status === "DRAFT") return draftBookings;
        if (where.status?.in?.includes("WAITLISTED")) return waitlistBookings;
        return confirmedBookings;
      }),
    },
    memberSubscription: {
      findMany: vi.fn().mockResolvedValue(subscriptions),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(async (callback: any) => callback(db)),
  };

  return db;
}

function makeRollForwardDb() {
  const sourceAssignments = [
    {
      id: "assignment-copy",
      memberId: "member-copy",
      seasonYear: 2026,
      membershipTypeId: "type-full",
      member: {
        id: "member-copy",
        firstName: "Casey",
        lastName: "Copy",
        email: "copy@example.test",
        active: true,
        archivedAt: null,
        cancelledAt: null,
      },
      membershipType: fullType,
    },
    {
      id: "assignment-inactive",
      memberId: "member-inactive",
      seasonYear: 2026,
      membershipTypeId: "type-inactive",
      member: {
        id: "member-inactive",
        firstName: "Ivy",
        lastName: "Inactive",
        email: "inactive@example.test",
        active: true,
        archivedAt: null,
        cancelledAt: null,
      },
      membershipType: inactiveType,
    },
    {
      id: "assignment-existing",
      memberId: "member-existing",
      seasonYear: 2026,
      membershipTypeId: "type-full",
      member: {
        id: "member-existing",
        firstName: "Tara",
        lastName: "Target",
        email: "target@example.test",
        active: true,
        archivedAt: null,
        cancelledAt: null,
      },
      membershipType: fullType,
    },
  ];

  const db = {
    seasonalMembershipAssignment: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.seasonYear === 2026) return sourceAssignments;
        return [{ memberId: "member-existing" }];
      }),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([
        sourceAssignments[0].member,
        sourceAssignments[1].member,
        sourceAssignments[2].member,
        {
          id: "member-missing",
          firstName: "Mia",
          lastName: "Missing",
          email: "missing@example.test",
          active: true,
          archivedAt: null,
          cancelledAt: null,
        },
      ]),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(async (callback: any) => callback(db)),
  };

  return db;
}

describe("seasonal membership assignment preview and save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SECRET = "seasonal-membership-test-secret";
  });

  it("previews affected bookings, waitlist records, and subscription summary without provider IDs", async () => {
    const db = makePreviewDb();

    const result = await getSeasonalMembershipChangePreview({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-associate",
      applyFrom: "2026-07-15",
      now: new Date("2026-07-01T00:00:00.000Z"),
      db: db as never,
    });

    expect(result.init?.status).toBeUndefined();
    const preview = (result.body as { preview: Record<string, unknown> })
      .preview;
    expect(preview).toMatchObject({
      memberId: "member-1",
      seasonYear: 2026,
      applyFrom: "2026-07-15",
      resultingBookingBehavior: "NON_MEMBER_RATE",
      resultingSubscriptionBehavior: "REQUIRED",
      bookingBehaviorChanged: true,
      subscriptionBehaviorChanged: false,
      affectedCounts: {
        futureConfirmedBookings: 2,
        draftBookings: 1,
        waitlistRecords: 1,
      },
      currentSeasonSubscription: {
        status: "PAID",
        hasInvoice: true,
        xeroInvoiceNumber: "INV-2026",
      },
    });
    expect(preview.previewToken).toEqual(expect.any(String));
    expect(JSON.stringify(preview)).not.toContain("xero-invoice-id-not-returned");
  });

  it("fails closed for preview tokens in production without an auth secret", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAuthSecret = process.env.AUTH_SECRET;
    const originalNextAuthSecret = process.env.NEXTAUTH_SECRET;
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const db = makePreviewDb();

    try {
      await expect(
        getSeasonalMembershipChangePreview({
          memberId: "member-1",
          seasonYear: 2026,
          membershipTypeId: "type-associate",
          now: new Date("2026-07-01T00:00:00.000Z"),
          db: db as never,
        }),
      ).rejects.toThrow(
        "AUTH_SECRET or NEXTAUTH_SECRET is required for seasonal membership preview tokens",
      );
    } finally {
      if (originalNodeEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).NODE_ENV;
      } else {
        (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
      }
      if (originalAuthSecret === undefined) {
        delete process.env.AUTH_SECRET;
      } else {
        process.env.AUTH_SECRET = originalAuthSecret;
      }
      if (originalNextAuthSecret === undefined) {
        delete process.env.NEXTAUTH_SECRET;
      } else {
        process.env.NEXTAUTH_SECRET = originalNextAuthSecret;
      }
    }
  });

  it("requires an admin reason before saving", async () => {
    const db = makePreviewDb();

    const result = await saveSeasonalMembershipAssignment({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-associate",
      adminMemberId: "admin-1",
      reason: "  ",
      previewToken: "unused",
      db: db as never,
    });

    expect(result.init?.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rejects stale preview tokens", async () => {
    const db = makePreviewDb();

    const result = await saveSeasonalMembershipAssignment({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-associate",
      adminMemberId: "admin-1",
      reason: "member changed category",
      previewToken: "not-the-preview-token",
      db: db as never,
    });

    expect(result.init?.status).toBe(409);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("saves with a matching preview token and audits old/new policy impact", async () => {
    const db = makePreviewDb();
    const previewResult = await getSeasonalMembershipChangePreview({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-associate",
      applyFrom: "2026-07-15",
      now: new Date("2026-07-01T00:00:00.000Z"),
      db: db as never,
    });
    const preview = (previewResult.body as { preview: { previewToken: string } })
      .preview;

    const result = await saveSeasonalMembershipAssignment({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-associate",
      applyFrom: "2026-07-15",
      adminMemberId: "admin-1",
      reason: "member changed category",
      previewToken: preview.previewToken,
      request: { id: "req-1", ipAddress: "127.0.0.1", userAgent: "vitest" },
      db: db as never,
    });

    expect(result.init?.status).toBeUndefined();
    expect(db.seasonalMembershipAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberId_seasonYear: { memberId: "member-1", seasonYear: 2026 },
        },
        update: {
          membershipTypeId: "type-associate",
          applyFrom: new Date("2026-07-15T00:00:00.000Z"),
          assignedByMemberId: "admin-1",
        },
      }),
    );
    // seasonYear 2026 is not necessarily the CURRENT season when this test
    // runs; the dedicated trigger tests below pin current vs future.
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION,
          actorMemberId: "admin-1",
          subjectMemberId: "member-1",
          category: "admin",
          severity: "critical",
          metadata: expect.objectContaining({
            seasonYear: 2026,
            adminReason: "member changed category",
            previousApplyFrom: "2026-05-15",
            newApplyFrom: "2026-07-15",
            affectedCounts: {
              futureConfirmedBookings: 2,
              draftBookings: 1,
              waitlistRecords: 1,
            },
            bookingBehaviorChanged: true,
            subscriptionBehaviorChanged: false,
            resultingBookingBehavior: "NON_MEMBER_RATE",
            resultingSubscriptionBehavior: "REQUIRED",
          }),
        }),
      }),
    );
  });

  it("fires the Xero contact-group trigger only for current-season saves", async () => {
    const currentSeason = getSeasonYear();

    async function saveForSeason(seasonYear: number) {
      const db = makePreviewDb();
      const previewResult = await getSeasonalMembershipChangePreview({
        memberId: "member-1",
        seasonYear,
        membershipTypeId: "type-associate",
        db: db as never,
      });
      const preview = (
        previewResult.body as { preview: { previewToken: string } }
      ).preview;
      return saveSeasonalMembershipAssignment({
        memberId: "member-1",
        seasonYear,
        membershipTypeId: "type-associate",
        adminMemberId: "admin-1",
        reason: "member changed category",
        previewToken: preview.previewToken,
        db: db as never,
      });
    }

    // Future season: grouping resolves at "now", so no trigger.
    const futureResult = await saveForSeason(currentSeason + 1);
    expect(futureResult.init?.status).toBeUndefined();
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();

    // Current season: the effective type may change now -> trigger fires.
    const currentResult = await saveForSeason(currentSeason);
    expect(currentResult.init?.status).toBeUndefined();
    expect(mockTriggerGroupSync).toHaveBeenCalledTimes(1);
    expect(mockTriggerGroupSync).toHaveBeenCalledWith("member-1", {
      createdByMemberId: "admin-1",
      reason: "seasonal_membership_assignment",
    });
  });
});

describe("seasonal membership assignment roll-forward", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("previews idempotent copies and reports missing/inactive exceptions", async () => {
    const db = makeRollForwardDb();

    const result = await rollForwardSeasonalMembershipAssignments({
      fromSeasonYear: 2026,
      toSeasonYear: 2027,
      adminMemberId: "admin-1",
      dryRun: true,
      db: db as never,
    });

    expect(result.init?.status).toBeUndefined();
    expect(result.body).toMatchObject({
      dryRun: true,
      sourceAssignmentCount: 3,
      wouldCopyCount: 2,
      copiedCount: 0,
      skippedExistingCount: 1,
      exceptionCount: 2,
      exceptions: expect.arrayContaining([
        expect.objectContaining({ code: "missing_prior_assignment" }),
        expect.objectContaining({
          code: "inactive_membership_type",
          membershipTypeName: "Inactive",
        }),
      ]),
    });
    expect(db.seasonalMembershipAssignment.createMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("runs roll-forward with skipDuplicates and writes a summary audit", async () => {
    const db = makeRollForwardDb();

    const result = await rollForwardSeasonalMembershipAssignments({
      fromSeasonYear: 2026,
      toSeasonYear: 2027,
      adminMemberId: "admin-1",
      request: { id: "req-1", ipAddress: "127.0.0.1", userAgent: "vitest" },
      db: db as never,
    });

    expect(result.body).toMatchObject({
      dryRun: false,
      wouldCopyCount: 2,
      copiedCount: 2,
      skippedExistingCount: 1,
    });
    expect(db.seasonalMembershipAssignment.createMany).toHaveBeenCalledWith({
      data: [
        {
          memberId: "member-copy",
          seasonYear: 2027,
          membershipTypeId: "type-full",
          applyFrom: null,
          assignedByMemberId: "admin-1",
        },
        {
          memberId: "member-inactive",
          seasonYear: 2027,
          membershipTypeId: "type-inactive",
          applyFrom: null,
          assignedByMemberId: "admin-1",
        },
      ],
      skipDuplicates: true,
    });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: SEASONAL_MEMBERSHIP_ASSIGNMENTS_ROLLED_FORWARD_ACTION,
          actorMemberId: "admin-1",
          category: "admin",
          severity: "important",
          metadata: expect.objectContaining({
            fromSeasonYear: 2026,
            toSeasonYear: 2027,
            copiedCount: 2,
            sourceAssignmentCount: 3,
            skippedExistingCount: 1,
            exceptionCount: 2,
          }),
        }),
      }),
    );
  });

  it("does not fire the Xero contact-group trigger when rolling forward to a non-current season", async () => {
    const db = makeRollForwardDb();

    await rollForwardSeasonalMembershipAssignments({
      // 2026 -> 2027 in the fixture; ensure 2027 is NOT the current season
      // for this assertion to be meaningful.
      fromSeasonYear: 2026,
      toSeasonYear: 2027,
      adminMemberId: "admin-1",
      db: db as never,
    });

    expect(getSeasonYear()).not.toBe(2027);
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
  });

  it("fires the trigger only for actually-copied candidates when rolling forward to the current season", async () => {
    const currentSeason = getSeasonYear();
    const priorSeason = currentSeason - 1;
    const candidates = ["member-copy", "member-race"].map((memberId, index) => ({
      id: `assignment-${memberId}`,
      memberId,
      seasonYear: priorSeason,
      membershipTypeId: "type-full",
      member: {
        id: memberId,
        firstName: `M${index}`,
        lastName: "Member",
        email: `${memberId}@example.test`,
        active: true,
        archivedAt: null,
        cancelledAt: null,
      },
      membershipType: fullType,
    }));

    const db = {
      seasonalMembershipAssignment: {
        findMany: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where.seasonYear === priorSeason) return candidates;
          if (where.memberId?.in) {
            // Post-copy verification: member-race lost the createMany
            // skipDuplicates race (a concurrent writer was rolled back), so
            // only member-copy holds a current-season assignment now.
            return [{ memberId: "member-copy" }];
          }
          // Target-season pre-read: nothing assigned yet.
          return [];
        }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      member: {
        findMany: vi
          .fn()
          .mockResolvedValue(candidates.map((candidate) => candidate.member)),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(async (callback: any) => callback(db)),
    };

    await rollForwardSeasonalMembershipAssignments({
      fromSeasonYear: priorSeason,
      toSeasonYear: currentSeason,
      adminMemberId: "admin-1",
      db: db as never,
    });

    expect(mockTriggerGroupSync).toHaveBeenCalledTimes(1);
    expect(mockTriggerGroupSync).toHaveBeenCalledWith("member-copy", {
      createdByMemberId: "admin-1",
      reason: "seasonal_membership_roll_forward",
    });
  });
});
