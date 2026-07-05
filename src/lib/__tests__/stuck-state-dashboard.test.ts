import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlags } from "@/config/schema";
import {
  getStuckStateDashboard,
  type StuckStateDashboardDependencies,
} from "@/lib/stuck-state-dashboard";

const modulesOn: FeatureFlags = {
  kiosk: true,
  chores: true,
  financeDashboard: true,
  waitlist: true,
  xeroIntegration: true,
  bedAllocation: true,
  internetBankingPayments: true,
  addressAutocomplete: true,
  groupBookings: true,
  lockers: true,
  induction: true,
  workParties: true,
  promoCodes: true,
  hutLeaders: true,
  communications: true,
  skifieldConditions: true,
  twoFactor: false,
  analytics: false,
};

function emptyEmailResponses() {
  return {
    deliverability: {
      summary: {
        activeCount: 0,
        bounceCount: 0,
        complaintCount: 0,
        eventsLast24h: 0,
      },
      suppressions: [],
    },
    exhaustedFailures: {
      summary: {
        activeCount: 0,
        reviewedCount: 0,
        scannedCount: 0,
        maxAttempts: 3,
      },
      failures: [],
      recentlyReviewed: [],
    },
    adminAlertDelivery: {
      summary: {
        recentCount: 0,
        lookbackDays: 7,
      },
      escalations: [],
    },
    tokenRecovery: {
      summary: {
        activeCount: 0,
        reissuedCount: 0,
        scannedCount: 0,
      },
      failures: [],
      recentlyReissued: [],
    },
  };
}

function buildDeps(overrides?: Partial<StuckStateDashboardDependencies>) {
  const emails = emptyEmailResponses();
  const deps: StuckStateDashboardDependencies = {
    db: {
      paymentRecoveryOperation: {
        count: vi.fn(),
      },
      booking: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      groupBookingSettlement: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      issueReport: {
        count: vi.fn().mockResolvedValue(0),
      },
    },
    loadEffectiveModuleFlags: vi.fn().mockResolvedValue(modulesOn),
    getXeroAdminHealthSnapshot: vi.fn().mockResolvedValue({
      unlinkedMembers: { count: 0, href: "/admin/members" },
      failedOperations: { count: 0, legacyCount: 0 },
      pendingOperations: { count: 0 },
      staleRunningOperations: { count: 0, thresholdMinutes: 30 },
      staleProcessingInboundEvents: { count: 0, thresholdMinutes: 30 },
      lastMembershipRefresh: {
        at: null,
        lastCronStatus: null,
        lastCronStartedAt: null,
      },
      missingInvoices: { count: 0 },
      refundsMissingCreditNotes: { count: 0, graceHours: 24 },
      contactGroupMismatches: { count: 0, cacheReady: true },
      contactLinkMismatches: { count: 0, cacheReady: true },
      apiBudget: {
        status: "healthy",
        usagePercent: 10,
        totalCalls: 10,
        failedCalls: 0,
      },
    }),
    getEmailDeliverabilityTelemetry: vi.fn().mockResolvedValue(emails.deliverability),
    getExhaustedEmailFailureReviewQueue: vi
      .fn()
      .mockResolvedValue(emails.exhaustedFailures),
    getAdminAlertDeliveryEscalations: vi
      .fn()
      .mockResolvedValue(emails.adminAlertDelivery),
    getTokenEmailRecoveryQueue: vi.fn().mockResolvedValue(emails.tokenRecovery),
    getWaitlistOfferEmailDeliveries: vi.fn().mockResolvedValue(new Map()),
    countUnconfirmedSchoolAttendeeLists: vi.fn().mockResolvedValue(0),
    getBedAllocationDashboard: vi.fn().mockResolvedValue({
      unallocatedGuestNights: [],
      suggestedUnallocatedGuestNights: [],
      warnings: [],
    }),
    getUnassignedHutLeaderDates: vi.fn().mockResolvedValue([]),
    loadHutLeaderLookaheadDays: vi.fn().mockResolvedValue(14),
  };

  return {
    ...deps,
    ...overrides,
    db: {
      ...deps.db,
      ...overrides?.db,
    },
  };
}

describe("getStuckStateDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates payment, Xero, email, waitlist, bed allocation, and lodge stuck states", async () => {
    const paymentCount = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);
    const waitlistBookings = [
      {
        id: "booking-expired",
        status: "WAITLIST_OFFERED",
        waitlistOfferedAt: new Date("2026-06-21T00:00:00.000Z"),
        waitlistOfferExpiresAt: new Date("2026-06-21T23:00:00.000Z"),
        member: { email: "one@example.org" },
      },
      {
        id: "booking-current",
        status: "WAITLIST_OFFERED",
        waitlistOfferedAt: new Date("2026-06-21T00:00:00.000Z"),
        waitlistOfferExpiresAt: new Date("2026-06-23T00:00:00.000Z"),
        member: { email: "two@example.org" },
      },
    ];
    const deps = buildDeps({
      db: {
        paymentRecoveryOperation: { count: paymentCount },
        booking: {
          findMany: vi.fn().mockResolvedValue(waitlistBookings),
          // #1349 crash-window detector: cancelled bookings holding a captured
          // payment with no recorded refund, recovery op, or narrative event.
          count: vi.fn().mockResolvedValue(4),
        },
        groupBookingSettlement: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        issueReport: {
          count: vi.fn().mockResolvedValue(17),
        },
      },
      getXeroAdminHealthSnapshot: vi.fn().mockResolvedValue({
        unlinkedMembers: { count: 0, href: "/admin/members" },
        failedOperations: { count: 6, legacyCount: 0 },
        pendingOperations: { count: 0 },
        staleRunningOperations: { count: 7, thresholdMinutes: 30 },
        staleProcessingInboundEvents: { count: 8, thresholdMinutes: 30 },
        lastMembershipRefresh: {
          at: null,
          lastCronStatus: null,
          lastCronStartedAt: null,
        },
        missingInvoices: { count: 9 },
        refundsMissingCreditNotes: { count: 10, graceHours: 24 },
        contactGroupMismatches: { count: 12, cacheReady: true },
        contactLinkMismatches: { count: 11, cacheReady: true },
        apiBudget: {
          status: "warning",
          usagePercent: 85,
          totalCalls: 850,
          failedCalls: 1,
        },
      }),
      getEmailDeliverabilityTelemetry: vi.fn().mockResolvedValue({
        summary: {
          activeCount: 4,
          bounceCount: 3,
          complaintCount: 1,
          eventsLast24h: 5,
        },
        suppressions: [],
      }),
      getExhaustedEmailFailureReviewQueue: vi.fn().mockResolvedValue({
        summary: {
          activeCount: 5,
          reviewedCount: 0,
          scannedCount: 5,
          maxAttempts: 3,
        },
        failures: [],
        recentlyReviewed: [],
      }),
      getAdminAlertDeliveryEscalations: vi.fn().mockResolvedValue({
        summary: {
          recentCount: 1,
          lookbackDays: 7,
        },
        escalations: [],
      }),
      getTokenEmailRecoveryQueue: vi.fn().mockResolvedValue({
        summary: {
          activeCount: 2,
          reissuedCount: 0,
          scannedCount: 2,
        },
        failures: [],
        recentlyReissued: [],
      }),
      getWaitlistOfferEmailDeliveries: vi.fn().mockResolvedValue(
        new Map([
          ["booking-expired", { needsOperatorAction: true }],
          ["booking-current", { needsOperatorAction: false }],
        ]),
      ),
      getBedAllocationDashboard: vi.fn().mockResolvedValue({
        unallocatedGuestNights: Array.from({ length: 13 }),
        suggestedUnallocatedGuestNights: Array.from({ length: 14 }),
        warnings: Array.from({ length: 15 }),
      }),
      getUnassignedHutLeaderDates: vi
        .fn()
        .mockResolvedValue(Array.from({ length: 16 })),
    });

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(dashboard.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "payment-recovery-exhausted",
          severity: "critical",
          owner: "Finance",
          count: 2,
        }),
        // #1349 (F2): CANCELLED bookings whose captured payment shows no
        // recorded refund, no recovery operation, and no cancellation
        // narrative — the crash-window signature that previously fired nothing.
        expect.objectContaining({
          id: "payment-cancelled-refund-unrecorded",
          severity: "critical",
          owner: "Finance",
          count: 4,
        }),
        expect.objectContaining({
          id: "xero-refunds-missing-credit-notes",
          severity: "critical",
          owner: "Finance",
          count: 10,
        }),
        expect.objectContaining({
          id: "email-token-recovery",
          severity: "critical",
          owner: "Admin",
          count: 2,
        }),
        expect.objectContaining({
          id: "waitlist-offer-email-failures",
          severity: "critical",
          owner: "Admin",
          count: 1,
        }),
        expect.objectContaining({
          id: "bed-allocation-unplaceable",
          severity: "critical",
          owner: "Lodge",
          count: 14,
        }),
        expect.objectContaining({
          id: "lodge-unassigned-hut-leaders",
          severity: "warning",
          owner: "Lodge",
          count: 16,
        }),
      ]),
    );
    expect(
      dashboard.domains.find((domain) => domain.domain === "waitlist"),
    ).toMatchObject({
      count: 2,
      itemCount: 2,
      highestSeverity: "critical",
    });
    expect(dashboard.totals.itemCount).toBeGreaterThan(10);
    expect(dashboard.totals.critical).toBeGreaterThan(0);
    expect(deps.getUnassignedHutLeaderDates).toHaveBeenCalledWith({
      lookAheadDays: 14,
    });
  });

  it("uses configured hut-leader lookahead for lodge stuck-state counts", async () => {
    const getUnassignedHutLeaderDates = vi
      .fn()
      .mockResolvedValue(Array.from({ length: 3 }));
    const deps = buildDeps({
      loadHutLeaderLookaheadDays: vi.fn().mockResolvedValue(21),
      getUnassignedHutLeaderDates,
    });
    vi.mocked(deps.db.paymentRecoveryOperation.count)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(getUnassignedHutLeaderDates).toHaveBeenCalledWith({
      lookAheadDays: 21,
    });
    expect(
      dashboard.items.find((item) => item.id === "lodge-unassigned-hut-leaders"),
    ).toMatchObject({
      count: 3,
      summary:
        "3 upcoming lodge dates in the next 21 days with bookings have no hut leader assigned.",
    });
  });

  it("does not query disabled module-specific surfaces", async () => {
    const deps = buildDeps({
      loadEffectiveModuleFlags: vi.fn().mockResolvedValue({
        ...modulesOn,
        xeroIntegration: false,
        waitlist: false,
        bedAllocation: false,
      }),
    });
    vi.mocked(deps.db.paymentRecoveryOperation.count)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(deps.getXeroAdminHealthSnapshot).not.toHaveBeenCalled();
    expect(deps.db.booking.findMany).not.toHaveBeenCalled();
    expect(deps.getBedAllocationDashboard).not.toHaveBeenCalled();
    expect(dashboard.items).toEqual([]);
  });

  it("scopes the cancelled-with-unrecorded-refund detector to the crash-window signature (#1349)", async () => {
    const bookingCount = vi.fn().mockResolvedValue(1);
    const deps = buildDeps({
      db: {
        paymentRecoveryOperation: { count: vi.fn().mockResolvedValue(0) },
        booking: {
          findMany: vi.fn().mockResolvedValue([]),
          count: bookingCount,
        },
        groupBookingSettlement: { findMany: vi.fn().mockResolvedValue([]) },
        issueReport: { count: vi.fn().mockResolvedValue(0) },
      },
    });

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    // A flagged booking is CANCELLED with a fully captured, unrefunded
    // payment and shows NO refund-recovery operation and NO cancellation
    // narrative event — deliberate zero-refund cancels (which write their
    // CANCELLED BookingEvent), refunded cancels (refundedAmountCents > 0),
    // and #1349 in-transaction enqueues (recovery op exists) are all excluded.
    expect(bookingCount).toHaveBeenCalledWith({
      where: {
        status: "CANCELLED",
        deletedAt: null,
        // 90-day lookback from `now`.
        updatedAt: { gte: new Date("2026-03-24T00:00:00.000Z") },
        payment: {
          is: {
            status: "SUCCEEDED",
            refundedAmountCents: 0,
            amountCents: { gt: 0 },
          },
        },
        paymentRecoveryOperations: {
          none: { type: "REFUND_BOOKING_MODIFICATION" },
        },
        events: {
          none: { type: "CANCELLED" },
        },
      },
    });
    expect(
      dashboard.items.find(
        (item) => item.id === "payment-cancelled-refund-unrecorded",
      ),
    ).toMatchObject({
      severity: "critical",
      owner: "Finance",
      count: 1,
    });
  });
});
