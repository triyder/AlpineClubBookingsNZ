/**
 * Issue #1093 regression: edit paths must price existing guests over exactly
 * the nights they hold (their stored BookingGuestNight set), never the full
 * booking range. A partial-stay (gap) guest must not grow phantom nights —
 * priced at current season rates — because someone else was added or removed,
 * and a date change resets everyone to the full new range (the documented
 * batch-path policy) while re-syncing their night rows.
 *
 * Unlike fix-mod-payment.test.ts this harness keeps the REAL pricing engine
 * (calculateBookingPrice + membership-type policy wrapper) and fakes only the
 * database and side-effect leaf modules, so the assertions pin actual money
 * math end-to-end through each path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockTransaction = vi.fn();
const mockMemberCount = vi.fn();
const mockMemberFindUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => {
      const fn = args[0];
      if (typeof fn === "function") return (mockTransaction as any)(fn);
      return Promise.resolve();
    },
    member: { count: mockMemberCount, findUnique: mockMemberFindUnique },
    bookingRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/capacity", () => ({
  checkCapacity: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  getOccupiedBedsForNight: vi.fn().mockReturnValue(0),
  LODGE_CAPACITY: 29,
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn().mockResolvedValue({ valid: true, violations: [] }),
  formatViolationsDetail: vi.fn().mockReturnValue(""),
}));
vi.mock("@/lib/change-fee", () => ({
  calculateChangeFee: vi.fn().mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 }),
}));
vi.mock("@/lib/cancellation", () => ({
  daysUntilDate: vi.fn().mockReturnValue(30),
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
  calculateDualRefundAmounts: vi.fn((basisAmountCents: number) => ({
    cardRefundAmountCents: basisAmountCents,
    cardRefundPercentage: 100,
    creditRefundAmountCents: basisAmountCents,
    creditRefundPercentage: 100,
  })),
}));
vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  validateAndCalculatePromoDiscount: vi.fn().mockResolvedValue({
    discount: { discountCents: 0, priceAdjustmentCents: 0, freeNightsUsed: 0, eligibleGuestCount: 0, allocations: [] },
    beneficiaryMemberIds: [],
  }),
  calculatePromoDiscountForGuestRates: vi.fn().mockReturnValue({ discountCents: 0, priceAdjustmentCents: 0, freeNightsUsed: 0, eligibleGuestCount: 0, allocations: [] }),
  shouldPersistPromoRedemption: vi.fn().mockReturnValue(true),
  redeemPromoCode: vi.fn(),
  replacePromoRedemptionAllocations: vi.fn(),
  deletePromoRedemptionAndAdjustCount: vi.fn(),
  getMemberFreeNightsUsed: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/stripe", () => ({
  processRefund: vi.fn().mockResolvedValue({ id: "re_1" }),
  createPaymentIntent: vi.fn().mockResolvedValue({ id: "pi_additional", client_secret: "secret" }),
  findOrCreateCustomer: vi.fn().mockResolvedValue({ id: "cus_123" }),
  getPaymentIntent: vi.fn(),
  constructWebhookEvent: vi.fn(),
  listRefundsForCharge: vi.fn().mockResolvedValue([]),
  cancelPaymentIntentIfCancellable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), createAuditLog: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendBookingModifiedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero", () => ({
  createXeroSupplementaryInvoice: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNoteForModification: vi.fn().mockResolvedValue(undefined),
  isXeroConnected: vi.fn().mockResolvedValue(false),
  createXeroInvoiceForBooking: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNote: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({ queueOperationId: "op1", message: "queued" }),
  enqueueXeroBookingInvoiceUpdateOperation: vi.fn().mockResolvedValue({ queueOperationId: "op2", message: "queued" }),
  enqueueXeroRefundCreditNoteOperation: vi.fn().mockResolvedValue({ queueOperationId: "op3", message: "queued" }),
  enqueueXeroSupplementaryInvoiceOperation: vi.fn().mockResolvedValue({ queueOperationId: "op4", message: "queued" }),
  enqueueXeroModificationCreditNoteOperation: vi.fn().mockResolvedValue({ queueOperationId: "op5", message: "queued" }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue(null),
  recordSkippedXeroBookingInvoiceUpdateOperation: vi.fn().mockResolvedValue({ queueOperationId: "op6", message: "skipped" }),
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent: vi.fn().mockResolvedValue({ released: 0, queueOperationIds: [] }),
}));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhook-log", () => ({ recordWebhookLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: vi.fn().mockResolvedValue({}),
  refundPaymentTransactions: vi.fn().mockResolvedValue({
    refunds: [{ refundId: "re_1", paymentIntentId: "pi_original", amountCents: 0 }],
  }),
  findPaymentTransactionByIntentId: vi.fn().mockResolvedValue(null),
  markPaymentIntentTransactionSucceeded: vi.fn().mockResolvedValue({}),
  markPaymentIntentTransactionFailed: vi.fn().mockResolvedValue({}),
  syncRefundsFromStripeCharge: vi.fn(),
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueueAdditionalPaymentIntentRecovery: vi.fn().mockResolvedValue({ id: "recovery_additional" }),
  completeCanceledSupersededPaymentIntentRecovery: vi.fn().mockResolvedValue(undefined),
  queueSupersededPaymentIntentRefundRecovery: vi.fn().mockResolvedValue(undefined),
  queueRefundRecoveryOperation: vi.fn().mockResolvedValue(undefined),
  getStripePaymentMethodId: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededAdditionalIntentCancellations: vi.fn().mockResolvedValue([]),
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/chore-cleanup", () => ({
  cleanupChoreAssignmentsForDateChange: vi.fn().mockResolvedValue({ choreWarnings: [] }),
  cleanupChoreAssignmentsForGuestStayRanges: vi.fn().mockResolvedValue({ choreWarnings: [] }),
}));
vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: vi.fn().mockResolvedValue(undefined),
  WAITLIST_OFFER_HOURS: 48,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/member-credit", () => ({
  createBookingModificationCredit: vi.fn().mockResolvedValue({ id: "credit1" }),
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from "@/lib/auth";
import { checkCapacity, checkCapacityForGuestRanges } from "@/lib/capacity";

const mockedAuth = vi.mocked(auth);
const mockedCheckCapacity = vi.mocked(checkCapacity);
const mockedCheckCapacityForGuestRanges = vi.mocked(checkCapacityForGuestRanges);

function makeSession() {
  return { user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }], email: "alice@test.com" } };
}

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-05T00:00:00.000Z"); // 4 nights: Aug 1-4

function night(day: string, priceCents: number) {
  return { stayDate: new Date(`2026-08-0${day}T00:00:00.000Z`), priceCents };
}

/**
 * Booking with two guests booked at 5000/night when current member rate is
 * 6000: g1 stays all 4 nights; g2 is the gap-stay guest holding only Aug 1
 * and Aug 3 (stay envelope Aug 1-4, night set with a hole at Aug 2).
 */
function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk1",
    memberId: "m1",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    status: "PAID",
    totalPriceCents: 30000,
    discountCents: 0,
    finalPriceCents: 30000,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    requiresAdminReview: false,
    adminReviewStatus: null,
    guests: [
      {
        id: "g1",
        bookingId: "bk1",
        firstName: "Alice",
        lastName: "Smith",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        priceCents: 20000,
        stayStart: CHECK_IN,
        stayEnd: CHECK_OUT,
        nights: [night("1", 5000), night("2", 5000), night("3", 5000), night("4", 5000)],
      },
      {
        id: "g2",
        bookingId: "bk1",
        firstName: "Gappy",
        lastName: "Stayer",
        ageTier: "ADULT",
        isMember: true,
        memberId: null,
        priceCents: 10000,
        stayStart: CHECK_IN,
        stayEnd: new Date("2026-08-04T00:00:00.000Z"),
        nights: [night("1", 5000), night("3", 5000)],
      },
    ],
    payment: {
      id: "p1",
      bookingId: "bk1",
      amountCents: 30000,
      source: "STRIPE",
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_original",
      stripeCustomerId: "cus_123",
      xeroInvoiceId: "inv_primary",
      refundedAmountCents: 0,
      changeFeeCents: 0,
      additionalPaymentIntentId: null,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
    },
    member: { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" },
    promoRedemption: null,
    ...overrides,
  };
}

const CURRENT_SEASON = [{
  id: "s1",
  startDate: new Date("2026-04-01T00:00:00.000Z"),
  endDate: new Date("2026-10-31T00:00:00.000Z"),
  rates: [
    { ageTier: "ADULT", isMember: true, pricePerNightCents: 6000 },
    { ageTier: "ADULT", isMember: false, pricePerNightCents: 8000 },
  ],
}];

function makeTx(
  booking: ReturnType<typeof makeBooking>,
  options?: {
    groupDiscountSetting?: {
      enabled: boolean;
      minGroupSize: number;
      summerOnly: boolean;
    } | null;
  },
) {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    booking: {
      findUnique: vi.fn().mockResolvedValue(booking),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ ...booking, ...data, guests: booking.guests, payment: booking.payment })),
    },
    bookingGuest: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new-g", ...data })),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    groupDiscountSetting: {
      findUnique: vi
        .fn()
        .mockResolvedValue(options?.groupDiscountSetting ?? null),
    },
    bookingGuestNight: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    bookingModification: { create: vi.fn().mockResolvedValue({ id: "mod1" }) },
    bookingRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    payment: { update: vi.fn().mockResolvedValue({}) },
    season: { findMany: vi.fn().mockResolvedValue(CURRENT_SEASON) },
    promoRedemption: { update: vi.fn().mockResolvedValue({}) },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    member: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(1) },
    seasonalMembershipAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberCount.mockResolvedValue(1);
  mockMemberFindUnique.mockResolvedValue({
    id: "m1",
    active: true,
    email: "alice@test.com",
    firstName: "Alice",
  } as any);
  mockedAuth.mockResolvedValue(makeSession() as any);
  mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
  mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 20, nightDetails: [] } as any);
});

describe("guest add prices existing guests over their stored nights (#1093)", () => {
  it("leaves a gap-stay guest's price untouched when another guest is added", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({
        guests: [{ firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true }],
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // New guest: 4 nights at the current 8000 rate (a member guest without a
    // linked memberId prices as non-member). The pre-fix bug additionally
    // added phantom Aug 2 + Aug 4 nights at 6000 to the gap-stay guest,
    // inflating the total by a further 12000 (74000 in all).
    const bookingUpdate = tx.booking.update.mock.calls
      .map(([args]: any[]) => args.data)
      .find((data: any) => data.totalPriceCents !== undefined);
    expect(bookingUpdate.totalPriceCents).toBe(30000 + 32000);
    expect(bookingUpdate.finalPriceCents).toBe(62000);

    // The added guest joins the uniform night-row model: one row per night.
    const createArgs = tx.bookingGuest.create.mock.calls[0][0].data;
    expect(createArgs.nights.create).toHaveLength(4);
    expect(createArgs.nights.create.map((n: any) => n.priceCents)).toEqual([8000, 8000, 8000, 8000]);
  });
});

describe("guest removal prices remaining guests over their stored nights (#1093)", () => {
  it("changes the total by exactly the removed guest's booked price", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    const { removeBookingGuestInTransaction } = await import("@/lib/booking-guest-removal-service");

    await removeBookingGuestInTransaction({
      tx: tx as any,
      bookingId: "bk1",
      guestId: "g1",
      actorMemberId: "m1",
      actorRole: "ADMIN",
      settlementMethod: "CREDIT" as any,
    });

    // Remaining gap-stay guest keeps exactly her two booked nights at their
    // locked 5000 (pre-fix she was repriced over the full range: 22000).
    const bookingUpdate = tx.booking.update.mock.calls
      .map(([args]: any[]) => args.data)
      .find((data: any) => data.totalPriceCents !== undefined);
    expect(bookingUpdate.totalPriceCents).toBe(10000);

    const modification = tx.bookingModification.create.mock.calls[0][0].data;
    expect(modification.priceDiffCents).toBe(-20000);
  });
});

describe("date change resets guests to the full new range (#1093 policy)", () => {
  it("re-syncs night rows to the new range with locked prices preserved", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { PUT } = await import("@/app/api/bookings/[id]/modify-dates/route");

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      // Extend by one night: Aug 1-5 stays, checkout Aug 6.
      body: JSON.stringify({ checkIn: "2026-08-01", checkOut: "2026-08-06" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // Both guests reset to the full new range. Locked nights keep 5000; new
    // nights (g1: Aug 5; g2: Aug 2, 4, 5) price at the current 6000.
    const bookingUpdate = tx.booking.update.mock.calls
      .map(([args]: any[]) => args.data)
      .find((data: any) => data.totalPriceCents !== undefined);
    expect(bookingUpdate.totalPriceCents).toBe(26000 + 28000);

    // Night rows are re-synced per guest: stale pre-change rows deleted, one
    // row per priced night of the new range written back.
    expect(tx.bookingGuestNight.deleteMany).toHaveBeenCalledWith({ where: { bookingGuestId: "g1" } });
    expect(tx.bookingGuestNight.deleteMany).toHaveBeenCalledWith({ where: { bookingGuestId: "g2" } });
    const createManyByGuest = new Map(
      tx.bookingGuestNight.createMany.mock.calls.map(([args]: any[]) => [
        args.data[0]?.bookingGuestId,
        args.data,
      ]),
    );
    expect(createManyByGuest.get("g1")).toHaveLength(5);
    expect(createManyByGuest.get("g1").map((row: any) => row.priceCents)).toEqual([
      5000, 5000, 5000, 5000, 6000,
    ]);
    expect(createManyByGuest.get("g2")).toHaveLength(5);
    expect(createManyByGuest.get("g2").map((row: any) => row.priceCents)).toEqual([
      5000, 6000, 5000, 6000, 6000,
    ]);
  });
});

describe("group discount on edit-path repricing (#1095)", () => {
  const QUALIFYING = { enabled: true, minGroupSize: 3, summerOnly: false };

  it("prices a guest added to a qualifying party at the discounted member rate", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking, { groupDiscountSetting: QUALIFYING });
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({
        guests: [{ firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true }],
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // The discount is per night and per party size: on Aug 1 and 3 the full
    // party of 3 (g1, gap-stay g2, new guest) meets minGroupSize 3 and the
    // (unlinked, hence non-member-rate) new guest prices at the member 6000;
    // on Aug 2 and 4 the gap-stay guest is absent, the party of 2 does not
    // qualify, and the new guest pays the non-member 8000. Locked guests
    // unchanged.
    const bookingUpdate = tx.booking.update.mock.calls
      .map(([args]: any[]) => args.data)
      .find((data: any) => data.totalPriceCents !== undefined);
    expect(bookingUpdate.totalPriceCents).toBe(30000 + 28000);

    const createArgs = tx.bookingGuest.create.mock.calls[0][0].data;
    expect(createArgs.priceCents).toBe(28000);
    expect(createArgs.nights.create.map((n: any) => n.priceCents)).toEqual([
      6000, 8000, 6000, 8000,
    ]);
  });

  it("does not discount an addition that leaves the party below the minimum", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking, {
      groupDiscountSetting: { enabled: true, minGroupSize: 5, summerOnly: false },
    });
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({
        guests: [{ firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true }],
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    const createArgs = tx.bookingGuest.create.mock.calls[0][0].data;
    expect(createArgs.priceCents).toBe(32000);
  });

  it("applies the discount to the nights a date extension adds for a qualifying party", async () => {
    const booking = makeBooking();
    // Make the gap-stay guest a non-member so the discount is visible on her
    // newly priced nights; her locked 5000s (bought under the discount) stay.
    booking.guests[1].isMember = false;
    const tx = makeTx(booking, {
      groupDiscountSetting: { enabled: true, minGroupSize: 2, summerOnly: false },
    });
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { PUT } = await import("@/app/api/bookings/[id]/modify-dates/route");

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-01", checkOut: "2026-08-06" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    // g1 (member): 4 locked + Aug 5 at 6000 = 26000. g2 (non-member): locked
    // Aug 1/3 at 5000, new Aug 2/4/5 at the discounted member 6000 = 28000
    // (34000 undiscounted). The party of 2 qualifies every night.
    const bookingUpdate = tx.booking.update.mock.calls
      .map(([args]: any[]) => args.data)
      .find((data: any) => data.totalPriceCents !== undefined);
    expect(bookingUpdate.totalPriceCents).toBe(26000 + 28000);
  });
});
