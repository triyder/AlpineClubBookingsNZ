import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";

// Hoisted spies so the module mocks below can reference them and tests can assert.
const h = vi.hoisted(() => ({
  txBookingFindUnique: vi.fn(),
  txBookingUpdate: vi.fn(),
  txGuestUpdate: vi.fn(),
  txGuestNightDeleteMany: vi.fn(),
  txGuestNightCreateMany: vi.fn(),
  txModificationCreate: vi.fn(),
  txPaymentUpdate: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  sendBookingModifiedEmail: vi.fn(),
  queueXeroBookingEditSettlement: vi.fn(),
  logAudit: vi.fn(),
  linkModification: vi.fn(),
  processWaitlistForDates: vi.fn(),
  getNonMemberHoldPolicy: vi.fn(),
  calculateBookingHoldDecision: vi.fn(),
  assertNoConflicts: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  cleanupDate: vi.fn(),
  cleanupRanges: vi.fn(),
  assertEnvelope: vi.fn(),
  assertNotQuotePriced: vi.fn(),
}));

const tx = {
  booking: { findUnique: h.txBookingFindUnique, update: h.txBookingUpdate },
  bookingGuest: { update: h.txGuestUpdate },
  bookingGuestNight: {
    deleteMany: h.txGuestNightDeleteMany,
    createMany: h.txGuestNightCreateMany,
  },
  bookingModification: { create: h.txModificationCreate },
  payment: { update: h.txPaymentUpdate },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (client: typeof tx) => unknown) => cb(tx),
  },
}));

vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return {
    ...actual,
    checkCapacityForGuestRanges: h.checkCapacityForGuestRanges,
    checkCapacity: vi.fn(),
    acquireLodgeCapacityLock: h.acquireLodgeCapacityLock,
  };
});

vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
  lodgeNullTolerantScope: () => ({}),
}));
vi.mock("@/lib/email", () => ({ sendBookingModifiedEmail: h.sendBookingModifiedEmail }));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: h.queueXeroBookingEditSettlement,
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/booking-change-request-linkage", () => ({
  linkModificationToOutstandingChangeRequest: h.linkModification,
}));
vi.mock("@/lib/waitlist", () => ({ processWaitlistForDates: h.processWaitlistForDates }));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  assertNoBookingMemberNightConflicts: h.assertNoConflicts,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: h.reconcileBedAllocations,
}));
vi.mock("@/lib/chore-cleanup", () => ({
  cleanupChoreAssignmentsForDateChange: h.cleanupDate,
  cleanupChoreAssignmentsForGuestStayRanges: h.cleanupRanges,
}));
vi.mock("@/lib/booking-envelope-invariants", () => ({
  assertBookingEnvelopeInvariants: h.assertEnvelope,
}));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldPolicy: h.getNonMemberHoldPolicy,
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
}));
vi.mock("@/lib/policies/booking-route-decisions", () => ({
  calculateBookingHoldDecision: h.calculateBookingHoldDecision,
  toGroupDiscountConfig: vi.fn(),
}));
vi.mock("@/lib/booking-modify", () => ({
  assertBookingNotQuotePriced: h.assertNotQuotePriced,
  applyPaymentAdjustments: vi.fn(),
  calculateModificationSettlementOptions: vi.fn(),
  lockedNightPricesForGuest: vi.fn(),
}));
vi.mock("@/lib/booking-modification-settlement", () => ({
  createModificationAdditionalPaymentIntent: vi.fn(),
  executeBookingModificationRefund: vi.fn(),
}));
vi.mock("@/lib/member-credit", () => ({ createBookingModificationCredit: vi.fn() }));
vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations: vi.fn(),
}));
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn(),
  MembershipTypeBookingPolicyError: class extends Error {},
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(),
}));
vi.mock("@/lib/promo", () => ({
  deletePromoRedemptionAndAdjustCount: vi.fn(),
  replacePromoRedemptionAllocations: vi.fn(),
  validateAndCalculatePromoDiscount: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { adminShiftBookingDates } from "@/lib/booking-date-modification-service";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

/**
 * A single-guest, all-member PAID booking: 3 nights of 10000c each = 30000c.
 * Each per-night row carries its own priceCents so the frozen-money assertion
 * checks the row level, not just the booking total.
 */
function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "b1",
    status: "PAID",
    lodgeId: "lodge-1",
    memberId: "m1",
    checkIn: D("2026-09-10"),
    checkOut: D("2026-09-13"),
    totalPriceCents: 30000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 30000,
    nonMemberHoldUntil: null,
    member: { email: "m@example.com", firstName: "Mia" },
    payment: null,
    guests: [
      {
        id: "g1",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        priceCents: 30000,
        stayStart: D("2026-09-10"),
        stayEnd: D("2026-09-13"),
        nights: [
          { stayDate: D("2026-09-10"), priceCents: 10000 },
          { stayDate: D("2026-09-11"), priceCents: 10000 },
          { stayDate: D("2026-09-12"), priceCents: 10000 },
        ],
      },
    ],
    ...overrides,
  };
}

function primeTx(booking: ReturnType<typeof makeBooking>) {
  // findUnique #1 = lock-target select {lodgeId}; #2 = full booking include.
  h.txBookingFindUnique
    .mockResolvedValueOnce({ lodgeId: booking.lodgeId })
    .mockResolvedValueOnce(booking);
  h.txBookingUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...booking, ...data, guests: booking.guests, payment: booking.payment }),
  );
  h.txModificationCreate.mockResolvedValue({ id: "mod_1" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(D("2026-09-01"));
  h.getDefaultLodgeId.mockResolvedValue("lodge-1");
  h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  h.assertNotQuotePriced.mockResolvedValue(undefined);
  h.assertNoConflicts.mockResolvedValue(undefined);
  h.reconcileBedAllocations.mockResolvedValue(undefined);
  h.cleanupDate.mockResolvedValue({ choreWarnings: [] });
  h.cleanupRanges.mockResolvedValue({ choreWarnings: [] });
  h.assertEnvelope.mockResolvedValue(undefined);
  h.sendBookingModifiedEmail.mockResolvedValue(undefined);
  h.processWaitlistForDates.mockResolvedValue(undefined);
  h.linkModification.mockResolvedValue(null);
  h.checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    minAvailable: 5,
    nightDetails: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("adminShiftBookingDates (issue #1668 — pure translation)", () => {
  it("rejects a non-admin actor with 403 and never opens a transaction", async () => {
    await expect(
      adminShiftBookingDates({
        bookingId: "b1",
        actor: { id: "u1", role: "USER" },
        input: { checkIn: "2026-09-12" },
        ipAddress: "1.1.1.1",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(h.txBookingFindUnique).not.toHaveBeenCalled();
  });

  it("freezes every cent while translating the stay by the day delta", async () => {
    const booking = makeBooking();
    primeTx(booking);

    const result = await adminShiftBookingDates({
      bookingId: "b1",
      actor: { id: "admin1", role: "ADMIN" },
      input: { checkIn: "2026-09-12" }, // derive checkout to preserve 3 nights
      ipAddress: "1.1.1.1",
    });

    // Booking envelope moved; NO money field written.
    const updateArgs = h.txBookingUpdate.mock.calls[0][0];
    expect(updateArgs.data.checkIn).toEqual(D("2026-09-12"));
    expect(updateArgs.data.checkOut).toEqual(D("2026-09-15"));
    expect(updateArgs.data).not.toHaveProperty("totalPriceCents");
    expect(updateArgs.data).not.toHaveProperty("finalPriceCents");
    expect(updateArgs.data).not.toHaveProperty("discountCents");

    // Guest envelope moved; NO priceCents written.
    const guestUpdate = h.txGuestUpdate.mock.calls[0][0];
    expect(guestUpdate.where).toEqual({ id: "g1" });
    expect(guestUpdate.data).toEqual({
      stayStart: D("2026-09-12"),
      stayEnd: D("2026-09-15"),
    });

    // Night rows rebuilt at shifted dates with the SAME per-night priceCents.
    const createManyArgs = h.txGuestNightCreateMany.mock.calls[0][0];
    expect(createManyArgs.data).toEqual([
      { bookingGuestId: "g1", stayDate: D("2026-09-12"), priceCents: 10000 },
      { bookingGuestId: "g1", stayDate: D("2026-09-13"), priceCents: 10000 },
      { bookingGuestId: "g1", stayDate: D("2026-09-14"), priceCents: 10000 },
    ]);

    // Modification row is a zero-money ADMIN_DATE_SHIFT.
    const modArgs = h.txModificationCreate.mock.calls[0][0];
    expect(modArgs.data.modificationType).toBe("ADMIN_DATE_SHIFT");
    expect(modArgs.data.priceDiffCents).toBe(0);
    expect(modArgs.data.changeFeeCents).toBe(0);
    expect(modArgs.data.newData.pricingMode).toBe("shift");
    expect(modArgs.data.newData.capacityOverridden).toBe(false);
    expect(modArgs.data.newData.finalPriceCents).toBe(30000);

    // No payment or Xero settlement writes at all.
    expect(h.txPaymentUpdate).not.toHaveBeenCalled();
    expect(h.queueXeroBookingEditSettlement).not.toHaveBeenCalled();

    // Response is all-zero money.
    expect(result.priceDiffCents).toBe(0);
    expect(result.changeFeeCents).toBe(0);
    expect(result.refundAmountCents).toBe(0);
    expect(result.capacityOverridden).toBe(false);
  });

  it("audits the move as booking.modify.admin_override and links the change request", async () => {
    const booking = makeBooking();
    primeTx(booking);
    h.linkModification.mockResolvedValue("req_9");

    await adminShiftBookingDates({
      bookingId: "b1",
      actor: { id: "admin1", role: "ADMIN" },
      input: { checkIn: "2026-09-12" },
      ipAddress: "1.1.1.1",
    });

    expect(h.linkModification).toHaveBeenCalledWith(
      expect.anything(),
      "b1",
      "mod_1",
    );
    const auditArgs = h.logAudit.mock.calls[0][0];
    expect(auditArgs.action).toBe("booking.modify.admin_override");
    expect(auditArgs.metadata.linkedChangeRequestId).toBe("req_9");
    expect(auditArgs.metadata.pricingMode).toBe("shift");
  });

  it("rejects a night-count change with the shift/recalculate guidance", async () => {
    const booking = makeBooking();
    primeTx(booking);

    await expect(
      adminShiftBookingDates({
        bookingId: "b1",
        actor: { id: "admin1", role: "ADMIN" },
        // 2-night span for a 3-night stay
        input: { checkIn: "2026-09-12", checkOut: "2026-09-14" },
        ipAddress: "1.1.1.1",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.txBookingUpdate).not.toHaveBeenCalled();
  });

  it("derives the missing check-in from a provided check-out (length preserved)", async () => {
    const booking = makeBooking();
    primeTx(booking);

    await adminShiftBookingDates({
      bookingId: "b1",
      actor: { id: "admin1", role: "ADMIN" },
      input: { checkOut: "2026-09-16" }, // 3 nights back → check-in 09-13
      ipAddress: "1.1.1.1",
    });

    const updateArgs = h.txBookingUpdate.mock.calls[0][0];
    expect(updateArgs.data.checkIn).toEqual(D("2026-09-13"));
    expect(updateArgs.data.checkOut).toEqual(D("2026-09-16"));
  });

  it("throws OverCapacityConfirmationRequiredError when over capacity without confirm", async () => {
    const booking = makeBooking();
    primeTx(booking);
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [
        { date: D("2026-09-12"), occupiedBeds: 30, availableBeds: -1 },
      ],
    });

    await expect(
      adminShiftBookingDates({
        bookingId: "b1",
        actor: { id: "admin1", role: "ADMIN" },
        input: { checkIn: "2026-09-12" },
        ipAddress: "1.1.1.1",
      }),
    ).rejects.toBeInstanceOf(OverCapacityConfirmationRequiredError);
    expect(h.txBookingUpdate).not.toHaveBeenCalled();
  });

  it("proceeds with capacityOverridden when the admin confirms the overbooking", async () => {
    const booking = makeBooking();
    primeTx(booking);
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [
        { date: D("2026-09-12"), occupiedBeds: 30, availableBeds: -1 },
      ],
    });

    const result = await adminShiftBookingDates({
      bookingId: "b1",
      actor: { id: "admin1", role: "ADMIN" },
      input: { checkIn: "2026-09-12", confirmOverCapacity: true },
      ipAddress: "1.1.1.1",
    });

    expect(result.capacityOverridden).toBe(true);
    const modArgs = h.txModificationCreate.mock.calls[0][0];
    expect(modArgs.data.newData.capacityOverridden).toBe(true);
  });

  it("skips the capacity check for a non-capacity-holding status (WAITLISTED)", async () => {
    // A waitlisted booking holds no bed, so its shift can never overbook —
    // no confirm prompt, no capacityOverridden, mirroring the recalculate
    // path's skipBookingLifecycleRules.
    const booking = makeBooking({ status: "WAITLISTED" });
    primeTx(booking);
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [
        { date: D("2026-09-12"), occupiedBeds: 30, availableBeds: -1 },
      ],
    });

    const result = await adminShiftBookingDates({
      bookingId: "b1",
      actor: { id: "admin1", role: "ADMIN" },
      input: { checkIn: "2026-09-12" },
      ipAddress: "1.1.1.1",
    });

    expect(h.checkCapacityForGuestRanges).not.toHaveBeenCalled();
    expect(result.capacityOverridden).toBe(false);
    expect(h.txBookingUpdate).toHaveBeenCalled();
  });

  it("does not email the member when the shifted stay is fully in the past", async () => {
    vi.setSystemTime(D("2026-09-20"));
    // Booking was 09-10..09-13; shift earlier so checkout stays past.
    const booking = makeBooking();
    primeTx(booking);

    await adminShiftBookingDates({
      bookingId: "b1",
      actor: { id: "admin1", role: "ADMIN" },
      input: { checkIn: "2026-09-08" }, // → checkout 09-11, still < today
      ipAddress: "1.1.1.1",
    });

    expect(h.sendBookingModifiedEmail).not.toHaveBeenCalled();
    // The move itself still happened.
    expect(h.txBookingUpdate).toHaveBeenCalled();
  });

  it("emails the member when the shifted stay still has a future check-out", async () => {
    const booking = makeBooking();
    primeTx(booking);

    await adminShiftBookingDates({
      bookingId: "b1",
      actor: { id: "admin1", role: "ADMIN" },
      input: { checkIn: "2026-09-12" }, // now = 09-01, checkout 09-15 future
      ipAddress: "1.1.1.1",
    });

    expect(h.sendBookingModifiedEmail).toHaveBeenCalledTimes(1);
    const emailArgs = h.sendBookingModifiedEmail.mock.calls[0][0];
    expect(emailArgs.changeFeeCents).toBe(0);
    expect(emailArgs.oldFinalPriceCents).toBe(emailArgs.newFinalPriceCents);
  });

  it("recalculates the non-member hold off the new check-in", async () => {
    const booking = makeBooking({
      status: "PENDING",
      nonMemberHoldUntil: D("2026-09-05"),
      guests: [
        {
          id: "g1",
          ageTier: "ADULT",
          isMember: false,
          memberId: null,
          priceCents: 30000,
          stayStart: D("2026-09-10"),
          stayEnd: D("2026-09-13"),
          nights: [
            { stayDate: D("2026-09-10"), priceCents: 10000 },
            { stayDate: D("2026-09-11"), priceCents: 10000 },
            { stayDate: D("2026-09-12"), priceCents: 10000 },
          ],
        },
      ],
    });
    primeTx(booking);
    h.getNonMemberHoldPolicy.mockResolvedValue({ enabled: true, holdDays: 3 });
    h.calculateBookingHoldDecision.mockReturnValue({ shouldBePending: true });

    await adminShiftBookingDates({
      bookingId: "b1",
      actor: { id: "admin1", role: "ADMIN" },
      input: { checkIn: "2026-09-12" },
      ipAddress: "1.1.1.1",
    });

    expect(h.getNonMemberHoldPolicy).toHaveBeenCalled();
    const updateArgs = h.txBookingUpdate.mock.calls[0][0];
    // hold = new check-in (09-12) minus 3 days = 09-09.
    expect(updateArgs.data.nonMemberHoldUntil).toEqual(D("2026-09-09"));
  });
});
