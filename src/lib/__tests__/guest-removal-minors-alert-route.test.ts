import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AdminReviewStatus, BookingStatus } from "@prisma/client";
import { ADULT_SUPERVISION_REVIEW_REASON } from "@/lib/booking-review";

// F27 / #1372 — call-site integration. Drives the REAL DELETE route through the
// REAL removeBookingGuestInTransaction so the guest composition (does an adult
// remain after the removal?) is what decides whether the admin alert fires.
//
// This deliberately does NOT stub `minorsOnlyReviewNewlyFlagged`: the flag is
// computed inside the service by the real minorsReviewAlertShouldFire({
// previous: <pre-edit booking>, updated: <written booking> }). So a regression
// that made the alert unconditional, or that swapped previous/updated (which
// would permanently disable the alert), would flip one of these assertions —
// gaps the isolated predicate/sender tests cannot catch.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  transaction: vi.fn(),
  memberFindUnique: vi.fn(),
  // booking-modify collaborators (trivial stubs — the review decision is real)
  assertBookingNotQuotePriced: vi.fn(),
  applyLifecycleTransitions: vi.fn(),
  applyPaymentAdjustments: vi.fn(),
  calculateModificationSettlementOptions: vi.fn(),
  lockedNightPricesForGuest: vi.fn(),
  // membership-type-policy (pricing) collaborators
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(),
  assertMembershipTypeBookingAllowed: vi.fn(),
  // route post-transaction side effects
  drainSupersededPrimaryIntents: vi.fn(),
  executeBookingModificationRefund: vi.fn(),
  createModificationAdditionalPaymentIntent: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  queueXeroBookingEditSettlement: vi.fn(),
  logAudit: vi.fn(),
  sendBookingModifiedEmail: vi.fn(),
  sendAdminMinorsOnlyReviewAlert: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    member: { findUnique: mocks.memberFindUnique },
  },
}));
vi.mock("@/lib/booking-edit-policy", () => ({
  getBookingEditPolicy: () => ({ canModify: true, mode: "future", reason: null }),
  usesActiveBookingEditLifecycle: () => true,
}));
vi.mock("@/lib/booking-modify", () => ({
  assertBookingNotQuotePriced: mocks.assertBookingNotQuotePriced,
  applyLifecycleTransitions: mocks.applyLifecycleTransitions,
  applyPaymentAdjustments: mocks.applyPaymentAdjustments,
  calculateModificationSettlementOptions: mocks.calculateModificationSettlementOptions,
  lockedNightPricesForGuest: mocks.lockedNightPricesForGuest,
}));
vi.mock("@/lib/membership-type-policy", () => ({
  priceBookingGuestsWithMembershipTypePolicy:
    mocks.priceBookingGuestsWithMembershipTypePolicy,
  assertMembershipTypeBookingAllowed: mocks.assertMembershipTypeBookingAllowed,
  getMembershipTypeBookingPolicyErrorBody: (err: { message: string }) => ({
    error: err.message,
  }),
  MembershipTypeBookingPolicyError: class MembershipTypeBookingPolicyError extends Error {
    status = 400;
  },
}));
vi.mock("@/lib/booking-modification-settlement", () => ({
  drainSupersededPrimaryIntents: mocks.drainSupersededPrimaryIntents,
  executeBookingModificationRefund: mocks.executeBookingModificationRefund,
  createModificationAdditionalPaymentIntent:
    mocks.createModificationAdditionalPaymentIntent,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcileBedAllocationsForBooking,
}));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: mocks.queueXeroBookingEditSettlement,
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/email", () => ({
  sendBookingModifiedEmail: mocks.sendBookingModifiedEmail,
  sendAdminMinorsOnlyReviewAlert: mocks.sendAdminMinorsOnlyReviewAlert,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { DELETE } from "@/app/api/bookings/[id]/guests/[guestId]/route";

const CHECK_IN = new Date("2027-07-15");
const CHECK_OUT = new Date("2027-07-17");

type Guest = {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: "ADULT" | "CHILD" | "YOUTH" | "INFANT";
  isMember: boolean;
  memberId: string | null;
};

const ADULT: Guest = {
  id: "g-adult",
  firstName: "Adam",
  lastName: "Adult",
  ageTier: "ADULT",
  isMember: true,
  memberId: "m1",
};
const CHILD: Guest = {
  id: "g-child",
  firstName: "Kid",
  lastName: "Young",
  ageTier: "CHILD",
  isMember: false,
  memberId: null,
};

function preEditBooking(guests: Guest[]) {
  return {
    id: "b1",
    memberId: "m1",
    status: BookingStatus.PAID,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    totalPriceCents: 8000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 8000,
    // Pre-edit review state: not flagged. A previous/updated swap in the
    // service would read THIS (unflagged) as the "updated" side and never fire.
    requiresAdminReview: false,
    adminReviewStatus: null,
    adminReviewReason: null,
    memberReviewJustification: null,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    guests: guests.map((g) => ({
      ...g,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      nights: [],
      priceCents: 4000,
    })),
    payment: null,
    member: {
      id: "m1",
      email: "owner@example.com",
      firstName: "Pat",
      lastName: "Owner",
    },
    promoRedemption: null,
  };
}

function buildTx(guests: Guest[]) {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    booking: {
      findUnique: vi.fn().mockResolvedValue(preEditBooking(guests)),
      // Echo the written review fields + status so the service's real
      // minorsReviewAlertShouldFire reads the actual computed state.
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "b1",
        memberId: "m1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        payment: null,
        ...data,
        guests: [{ id: "g-remaining" }],
      })),
    },
    bookingGuest: {
      delete: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    season: { findMany: vi.fn().mockResolvedValue([]) },
    groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    bookingModification: {
      create: vi.fn().mockResolvedValue({ id: "mod_1" }),
    },
  };
}

function makeRequest() {
  return new NextRequest("https://example.test/api/bookings/b1/guests/g1", {
    method: "DELETE",
  });
}

async function runRemoval(removedGuestId: string, guests: Guest[]) {
  mocks.transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
    cb(buildTx(guests)),
  );
  return DELETE(makeRequest(), {
    params: Promise.resolve({ id: "b1", guestId: removedGuestId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
  });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.memberFindUnique.mockResolvedValue({
    id: "m1",
    email: "owner@example.com",
    firstName: "Pat",
    lastName: "Owner",
  });
  mocks.assertBookingNotQuotePriced.mockResolvedValue(undefined);
  mocks.lockedNightPricesForGuest.mockReturnValue(null);
  mocks.assertMembershipTypeBookingAllowed.mockResolvedValue(undefined);
  // One remaining guest priced trivially (remainingGuests always length 1 here).
  mocks.priceBookingGuestsWithMembershipTypePolicy.mockResolvedValue({
    totalPriceCents: 4000,
    guests: [{ perNightCents: [4000], nightDates: [CHECK_IN], priceCents: 4000 }],
  });
  mocks.calculateModificationSettlementOptions.mockResolvedValue(null);
  mocks.applyPaymentAdjustments.mockResolvedValue({
    refundAmountCents: 0,
    accountCreditAmountCents: 0,
    pendingRefundAmountCents: 0,
    additionalAmountCents: 0,
    settlementMethod: null,
    policyRetainedAmountCents: 0,
    xeroRefundAmountCents: 0,
    xeroAdditionalAmountCents: 0,
    hasSucceededPayment: false,
    hasIssuedXeroInvoice: false,
  });
  // The booking stays PAID (Option A / #1100) — never parked to AWAITING_REVIEW.
  mocks.applyLifecycleTransitions.mockResolvedValue({
    hasNonMembers: false,
    newNonMemberHoldUntil: null,
    newStatus: BookingStatus.PAID,
    zeroDollarAutoPaid: false,
    supersededPrimaryPaymentIntents: [],
  });
  mocks.drainSupersededPrimaryIntents.mockResolvedValue(undefined);
  mocks.executeBookingModificationRefund.mockResolvedValue(null);
  mocks.createModificationAdditionalPaymentIntent.mockResolvedValue({
    additionalPaymentClientSecret: null,
    additionalPaymentIntentId: null,
  });
  mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
  mocks.queueXeroBookingEditSettlement.mockResolvedValue(undefined);
  mocks.sendBookingModifiedEmail.mockResolvedValue(undefined);
  mocks.sendAdminMinorsOnlyReviewAlert.mockResolvedValue(undefined);
});

describe("DELETE guest removal — minors-only admin alert wiring (#1372)", () => {
  it("alerts admins when removing the last adult leaves a paid booking minors-only", async () => {
    const res = await runRemoval("g-adult", [ADULT, CHILD]);

    expect(res.status).toBe(200);
    // Sanity: the route ran to completion (member email sent).
    expect(mocks.sendBookingModifiedEmail).toHaveBeenCalledTimes(1);
    // The real service flagged it and the route's call site fired the alert
    // with the freshly-written booking's details.
    expect(mocks.sendAdminMinorsOnlyReviewAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminMinorsOnlyReviewAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Pat Owner",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guestCount: 1,
        reviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      }),
    );
  });

  it("does not alert when an adult remains after the removal", async () => {
    const res = await runRemoval("g-child", [ADULT, CHILD]);

    expect(res.status).toBe(200);
    expect(mocks.sendBookingModifiedEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminMinorsOnlyReviewAlert).not.toHaveBeenCalled();
  });

  it("does not double-fire the alert when the booking was already under review", async () => {
    // Pre-edit booking already carried a pending minors-only review: removing a
    // further guest that keeps it minors-only must not re-alert (#1372).
    mocks.transaction.mockImplementation((cb: (tx: unknown) => unknown) => {
      const tx = buildTx([ADULT, CHILD]);
      tx.booking.findUnique.mockResolvedValue({
        ...preEditBooking([ADULT, CHILD]),
        requiresAdminReview: true,
        adminReviewStatus: AdminReviewStatus.PENDING,
        adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      });
      return cb(tx);
    });

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: "b1", guestId: "g-adult" }),
    });

    expect(res.status).toBe(200);
    expect(mocks.sendAdminMinorsOnlyReviewAlert).not.toHaveBeenCalled();
  });
});
