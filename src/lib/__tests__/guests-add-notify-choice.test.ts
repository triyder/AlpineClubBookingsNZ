/**
 * Issue #1769b (#1705 semantics): the admin's per-action member-email choice on
 * the dual-actor guest-add route (`POST /api/bookings/[id]/guests`). Absent =
 * notify (default); `false` suppresses the booking-modified email. Only an admin
 * actor may carry the flag — a member self-service caller carrying it is 403'd
 * before any work, and a suppression is recorded in the audit metadata as
 * `notifyMember: false` (the guest-add email always sends when a member exists,
 * so the field is recorded whenever the flag suppresses it).
 *
 * The harness mirrors partial-stay-edit-pricing.test.ts: it keeps the REAL
 * pricing engine and fakes only the database and side-effect leaf modules, so
 * the notify gating is exercised through the actual route end-to-end.
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
    booking: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
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
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  LODGE_CAPACITY: 29,
}));
vi.mock("@/lib/cancellation", () => ({
  daysUntilDate: vi.fn().mockReturnValue(30),
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
  getNonMemberHoldPolicy: vi.fn().mockResolvedValue({
    enabled: true,
    holdDays: 7,
    source: "default",
  }),
}));
vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  validateAndCalculatePromoDiscount: vi.fn().mockResolvedValue({
    discount: { discountCents: 0, priceAdjustmentCents: 0, freeNightsUsed: 0, eligibleGuestCount: 0, allocations: [] },
    beneficiaryMemberIds: [],
  }),
  replacePromoRedemptionAllocations: vi.fn(),
  deletePromoRedemptionAndAdjustCount: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), createAuditLog: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendBookingModifiedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from "@/lib/auth";
import { checkCapacity, checkCapacityForGuestRanges } from "@/lib/capacity";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";

const mockedAuth = vi.mocked(auth);
const mockedCheckCapacity = vi.mocked(checkCapacity);
const mockedCheckCapacityForGuestRanges = vi.mocked(checkCapacityForGuestRanges);
const mockedLogAudit = vi.mocked(logAudit);
const mockedSendModifiedEmail = vi.mocked(sendBookingModifiedEmail);

function makeMemberSession() {
  return { user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }], email: "alice@test.com" } };
}

function makeAdminSession() {
  return { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "admin@test.com" } };
}

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-05T00:00:00.000Z"); // 4 nights: Aug 1-4

function night(day: string, priceCents: number) {
  return { stayDate: new Date(`2026-08-0${day}T00:00:00.000Z`), priceCents };
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk1",
    memberId: "m1",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    status: "PAID",
    totalPriceCents: 20000,
    discountCents: 0,
    finalPriceCents: 20000,
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
    ],
    payment: {
      id: "p1",
      bookingId: "bk1",
      amountCents: 20000,
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

function makeTx(booking: ReturnType<typeof makeBooking>) {
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
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new-g", ...data })),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    groupDiscountSetting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    bookingGuestNight: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    bookingModification: { create: vi.fn().mockResolvedValue({ id: "mod1" }) },
    bookingRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    payment: { update: vi.fn().mockResolvedValue({}) },
    season: { findMany: vi.fn().mockResolvedValue(CURRENT_SEASON) },
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
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

function guestsRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/bookings/bk1/guests", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "bk1" }) };
const NON_MEMBER_GUEST = { firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: false };

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberCount.mockResolvedValue(1);
  mockMemberFindUnique.mockResolvedValue({
    id: "m1",
    active: true,
    email: "alice@test.com",
    firstName: "Alice",
  } as any);
  mockedAuth.mockResolvedValue(makeMemberSession() as any);
  mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
  mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 20, nightDetails: [] } as any);
});

describe("POST /api/bookings/[id]/guests notify choice (#1769b)", () => {
  it("emails the member and records no notify field on a member self-add without the flag", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(guestsRequest({ guests: [NON_MEMBER_GUEST] }), params);

    expect(res.status).toBe(200);
    expect(mockedSendModifiedEmail).toHaveBeenCalledTimes(1);
    const metadata = mockedLogAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("notifyMember");
  });

  it("suppresses the email and records notifyMember:false for an admin add with notifyMember:false", async () => {
    mockedAuth.mockResolvedValue(makeAdminSession() as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(
      guestsRequest({ guests: [NON_MEMBER_GUEST], notifyMember: false }),
      params,
    );

    expect(res.status).toBe(200);
    expect(mockedSendModifiedEmail).not.toHaveBeenCalled();
    const metadata = mockedLogAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({ notifyMember: false });
  });

  it("emails and records no notify field for an admin add with notifyMember:true", async () => {
    mockedAuth.mockResolvedValue(makeAdminSession() as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(
      guestsRequest({ guests: [NON_MEMBER_GUEST], notifyMember: true }),
      params,
    );

    expect(res.status).toBe(200);
    expect(mockedSendModifiedEmail).toHaveBeenCalledTimes(1);
    const metadata = mockedLogAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("notifyMember");
  });

  it("rejects a non-boolean notifyMember with 400 and runs no transaction, email, or audit", async () => {
    mockedAuth.mockResolvedValue(makeAdminSession() as any);
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(
      guestsRequest({ guests: [NON_MEMBER_GUEST], notifyMember: "false" }),
      params,
    );

    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockedSendModifiedEmail).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });

  it("rejects a non-admin actor carrying notifyMember with 403 before any work", async () => {
    // Member session (default): a self-service caller may not suppress their own
    // booking-modified email.
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(
      guestsRequest({ guests: [NON_MEMBER_GUEST], notifyMember: false }),
      params,
    );

    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockedSendModifiedEmail).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });
});
