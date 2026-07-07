import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";

// Cross-lodge waitlist confirm (ADR-004): Phase-1 duplicate-stay guard (M3).
// If an earlier confirm's Phase 3 (cancel the entry) failed, the entry is
// stranded in WAITLIST_OFFERED with a booking already created at the offered
// lodge; a re-confirm must not create a SECOND booking for the same stay.

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingFindFirst: vi.fn(),
  bookingUpdate: vi.fn(),
  lodgeFindUnique: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  isMemberEligibleToBookLodge: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  createConfirmedBooking: vi.fn(),
  getNonMemberHoldDays: vi.fn(),
  recordBookingEvent: vi.fn(),
  logAudit: vi.fn(),
}));

const txClient = {
  booking: {
    findUnique: mocks.bookingFindUnique,
    findFirst: mocks.bookingFindFirst,
    update: mocks.bookingUpdate,
  },
  lodge: { findUnique: mocks.lodgeFindUnique },
};

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
  checkCapacityForGuestRanges: mocks.checkCapacityForGuestRanges,
}));
vi.mock("@/lib/lodge-access", () => ({
  isMemberEligibleToBookLodge: mocks.isMemberEligibleToBookLodge,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcileBedAllocations,
}));
vi.mock("@/lib/booking-create", () => ({
  createConfirmedBooking: mocks.createConfirmedBooking,
}));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: mocks.getNonMemberHoldDays,
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { confirmCrossLodgeWaitlistOffer } from "@/lib/waitlist-cross-lodge";

const CHECK_IN = new Date("2026-08-10");
const CHECK_OUT = new Date("2026-08-12");

function offeredEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    memberId: "member-1",
    status: BookingStatus.WAITLIST_OFFERED,
    waitlistOfferExpiresAt: new Date(Date.now() + 86_400_000),
    waitlistOfferedLodgeId: "lodge-b",
    waitlistOfferedPriceCents: 34_000,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guests: [],
    promoRedemption: null,
    notes: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (cb: (tx: typeof txClient) => unknown) => cb(txClient),
  );
  mocks.bookingFindUnique.mockResolvedValue(offeredEntry());
  mocks.lodgeFindUnique.mockResolvedValue({ active: true });
  mocks.isMemberEligibleToBookLodge.mockResolvedValue(true);
  mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  mocks.reconcileBedAllocations.mockResolvedValue(undefined);
  mocks.bookingUpdate.mockResolvedValue({});
  // Default: no duplicate stay.
  mocks.bookingFindFirst.mockResolvedValue(null);
});

describe("confirmCrossLodgeWaitlistOffer duplicate-stay guard (M3)", () => {
  it("rejects with DUPLICATE_STAY and creates no booking when the member already holds an overlapping active stay at the offered lodge", async () => {
    // The member already has a real (PAYMENT_PENDING) booking overlapping the
    // offer's dates at the offered lodge — the residue of a stranded confirm.
    mocks.bookingFindFirst.mockResolvedValue({ id: "existing-booking" });

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.success).toBe(false);
    expect(result.code).toBe("DUPLICATE_STAY");
    // The whole point of the guard: no second booking is created.
    expect(mocks.createConfirmedBooking).not.toHaveBeenCalled();
    // The offer is left intact (not reverted) — the member cancels the
    // duplicate and re-confirms.
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();

    // The guard is scoped to the member, the offered lodge, active statuses
    // (PAYMENT_PENDING counts), an overlapping range, and excludes the entry.
    const where = mocks.bookingFindFirst.mock.calls[0][0].where;
    expect(where).toEqual(
      expect.objectContaining({
        memberId: "member-1",
        lodgeId: "lodge-b",
        id: { not: "entry-1" },
        deletedAt: null,
        checkIn: { lt: CHECK_OUT },
        checkOut: { gt: CHECK_IN },
      }),
    );
    expect(where.status.in).toEqual(
      expect.arrayContaining([
        BookingStatus.PAYMENT_PENDING,
        BookingStatus.PENDING,
        BookingStatus.CONFIRMED,
        BookingStatus.PAID,
      ]),
    );
    // Waitlist placeholders must NOT count as duplicate stays.
    expect(where.status.in).not.toContain(BookingStatus.WAITLISTED);
    expect(where.status.in).not.toContain(BookingStatus.WAITLIST_OFFERED);
    expect(where.status.in).not.toContain(BookingStatus.CANCELLED);
  });

  it("does not trip on the entry's own booking: the guard excludes it by id and the confirm proceeds past the guard", async () => {
    // No duplicate found (the entry itself is excluded by `id: { not }`), so
    // the confirm advances to the capacity re-check. Fail capacity there to
    // stop before the create path — the rejection is NOT the duplicate one.
    mocks.bookingFindFirst.mockResolvedValue(null);
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: false });

    const result = await confirmCrossLodgeWaitlistOffer("entry-1", "member-1");

    expect(result.success).toBe(false);
    // Not rejected as a duplicate — it got past the guard.
    expect(result.code).toBeUndefined();
    expect(result.error).toContain("Capacity is no longer available");
    expect(mocks.createConfirmedBooking).not.toHaveBeenCalled();
    // The guard query excluded the entry's own id.
    expect(mocks.bookingFindFirst.mock.calls[0][0].where.id).toEqual({
      not: "entry-1",
    });
  });
});
