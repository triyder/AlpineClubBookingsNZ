import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// #2124: a member at the lodge who wants to extend their stay one night at a
// time must not be blocked by a minimum-stay rule (e.g. a 2-night weekend
// minimum) evaluated against the added night alone. Because an in-progress
// edit keeps the original (past) check-in fixed, the modify-quote preview
// evaluates `validateMinimumStay` over the WHOLE contiguous stay
// [checkIn, newCheckOut] — so the already-valid original plus the added
// night(s) is what the policy sees. This suite pins:
//   (a) an in-progress check-out extension validates the whole stay (not the
//       added night) and is accepted when the whole stay clears the minimum;
//   (b) a genuinely-short whole stay is still reported;
//   (c) admins skip the minimum-stay check entirely;
//   (d) a future (pre-stay) edit still validates its own requested range;
//   (e) the extension still runs the capacity check for the added nights — no
//       capacity bypass sneaks in with the minimum-stay change.

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  authorizationRole: vi.fn(),
  bookingFindUnique: vi.fn(),
  seasonFindMany: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
  bookingRequestFindFirst: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  findConflicts: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  getLodgeCapacity: vi.fn(),
  priceGuests: vi.fn(),
  calculateChangeFee: vi.fn(),
  loadModuleFlags: vi.fn(),
  isXeroConnected: vi.fn(),
  getXeroLockDates: vi.fn(),
  validateMinimumStay: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.authorizationRole,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: h.bookingFindUnique },
    season: { findMany: h.seasonFindMany },
    groupDiscountSetting: { findUnique: h.groupDiscountFindUnique },
    bookingRequest: { findFirst: h.bookingRequestFindFirst },
  },
}));
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return { ...actual, checkCapacityForGuestRanges: h.checkCapacityForGuestRanges };
});
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: h.findConflicts,
  getBookingMemberNightConflictResponse: (conflicts: unknown[]) => ({
    code: "BOOKING_MEMBER_NIGHT_CONFLICT",
    conflicts,
  }),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
  lodgeNullTolerantScope: () => ({}),
}));
vi.mock("@/lib/lodge-capacity", () => ({ getLodgeCapacity: h.getLodgeCapacity }));
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  resolveGuestRateMembershipTypes: vi
    .fn()
    .mockImplementation((_db: unknown, { guests }: { guests: Array<Record<string, unknown>> }) =>
      Promise.resolve(
        guests.map((g) => ({
          ...g,
          rateMembershipTypeId: "type-nonmember",
          rateSource: "NON_MEMBER_DEFAULT",
        })),
      ),
    ),
  priceBookingGuestsWithMembershipTypePolicy: h.priceGuests,
  MembershipTypeBookingPolicyError: class extends Error {},
  getMembershipTypeBookingPolicyErrorBody: (e: Error) => ({ error: e.message }),
}));
vi.mock("@/lib/booking-modify", () => ({
  isQuotePricedBooking: vi.fn().mockResolvedValue(false),
  resolveGuestNameUpdates: vi.fn().mockReturnValue([]),
  lockedNightPricesForGuest: vi.fn().mockReturnValue(null),
  calculateModificationSettlementOptions: vi.fn().mockResolvedValue(null),
  QUOTE_PRICED_EDIT_BLOCK_MESSAGE: "quote-priced",
}));
vi.mock("@/lib/booking-guests", () => ({
  resolveLinkedBookingMembers: vi.fn().mockResolvedValue([]),
  assertLinkedBookingMembersCanBeBooked: vi.fn().mockResolvedValue(undefined),
  normalizeBookingGuestInputs: vi.fn().mockReturnValue([]),
  BookingGuestValidationError: class extends Error {},
  getBookingGuestValidationErrorResponse: (e: Error) => ({ error: e.message }),
}));
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  daysUntilDate: vi.fn().mockReturnValue(5),
}));
vi.mock("@/lib/change-fee", () => ({ calculateChangeFee: h.calculateChangeFee }));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: h.loadModuleFlags,
}));
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: h.isXeroConnected,
}));
vi.mock("@/lib/xero-organisation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xero-organisation")>();
  return { ...actual, getXeroLockDates: h.getXeroLockDates };
});
// #2124: control the minimum-stay verdict and capture the exact range the
// route validates, so the whole-stay evaluation can be asserted directly.
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: h.validateMinimumStay,
  formatViolationsDetail: (violations: unknown[]) =>
    `minimum-stay violations: ${violations.length}`,
  formatViolationMessage: () => "minimum-stay violation",
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { POST } from "@/app/api/bookings/[id]/modify-quote/route";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

// A fixed NZ "today" inside the in-progress stay, with multi-day margins so the
// Pacific/Auckland date-only normalization can never flip the edit-policy branch.
const NOW = new Date("2026-08-15T06:00:00.000Z");

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

// In-progress booking: check-in 2026-08-14 <= today 2026-08-15 < check-out
// 2026-08-18. A four-night stay already satisfying any minimum it was booked
// under; extending the check-out adds contiguous nights.
function inProgressBooking() {
  return {
    id: "b1",
    status: "PAID",
    memberId: "m1",
    lodgeId: "lodge-1",
    checkIn: D("2026-08-14"),
    checkOut: D("2026-08-18"),
    totalPriceCents: 30000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 30000,
    payment: null,
    promoRedemption: null,
    guests: [
      {
        id: "g1",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        stayStart: D("2026-08-14"),
        stayEnd: D("2026-08-18"),
        priceCents: 30000,
        nights: [
          { stayDate: D("2026-08-14"), priceCents: 7500 },
          { stayDate: D("2026-08-15"), priceCents: 7500 },
          { stayDate: D("2026-08-16"), priceCents: 7500 },
          { stayDate: D("2026-08-17"), priceCents: 7500 },
        ],
      },
    ],
  };
}

// A future (pre-stay) booking: check-in 2026-09-01 > today.
function futureBooking() {
  return {
    ...inProgressBooking(),
    checkIn: D("2026-09-01"),
    checkOut: D("2026-09-03"),
    guests: [
      {
        id: "g1",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        stayStart: D("2026-09-01"),
        stayEnd: D("2026-09-03"),
        priceCents: 15000,
        nights: [
          { stayDate: D("2026-09-01"), priceCents: 7500 },
          { stayDate: D("2026-09-02"), priceCents: 7500 },
        ],
      },
    ],
  };
}

// The in-progress plan prices the extension nights per-night from the seeded
// seasons (the resolver mock stamps guests type-nonmember), so any 200-path
// in-progress case needs a covering rate row.
function seedAugustRates() {
  h.seasonFindMany.mockResolvedValue([
    {
      id: "season-1",
      startDate: D("2026-06-01"),
      endDate: D("2026-10-31"),
      membershipTypeRates: [
        { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: 7500 },
        { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 7500 },
      ],
    },
  ]);
}

function asMember() {
  h.auth.mockResolvedValue({ user: { id: "m1" } });
  h.authorizationRole.mockReturnValue("USER");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  // Default: admin actor (overridden by asMember() where needed).
  h.auth.mockResolvedValue({ user: { id: "admin1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("ADMIN");
  h.bookingFindUnique.mockResolvedValue(inProgressBooking());
  seedAugustRates();
  h.groupDiscountFindUnique.mockResolvedValue(null);
  h.bookingRequestFindFirst.mockResolvedValue(null);
  h.getDefaultLodgeId.mockResolvedValue("lodge-1");
  h.getLodgeCapacity.mockResolvedValue(29);
  h.findConflicts.mockResolvedValue([]);
  h.checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    minAvailable: 5,
    nightDetails: [],
  });
  h.priceGuests.mockResolvedValue({
    totalPriceCents: 40000,
    guests: [{ priceCents: 40000, perNightCents: [7500, 7500], nightDates: [] }],
  });
  h.calculateChangeFee.mockReturnValue({ feeCents: 0 });
  h.loadModuleFlags.mockResolvedValue({ xeroIntegration: false });
  h.isXeroConnected.mockResolvedValue(true);
  h.getXeroLockDates.mockResolvedValue({
    periodLockDate: null,
    endOfYearLockDate: null,
  });
  // Whole stay clears the minimum by default.
  h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /api/bookings/[id]/modify-quote in-stay minimum-stay (#2124)", () => {
  it("validates the WHOLE contiguous stay (past check-in → new check-out) on an in-progress extension", async () => {
    asMember();

    const res = await POST(req({ checkOut: "2026-08-20" }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.minimumStayValid).toBe(true);

    // The policy saw the whole stay: the original (past) check-in, NOT the
    // added night alone, through the extended check-out.
    expect(h.validateMinimumStay).toHaveBeenCalledTimes(1);
    const [checkInArg, checkOutArg, lodgeArg] =
      h.validateMinimumStay.mock.calls[0];
    expect((checkInArg as Date).getTime()).toBe(D("2026-08-14").getTime());
    expect((checkOutArg as Date).getTime()).toBe(D("2026-08-20").getTime());
    expect(lodgeArg).toBe("lodge-1");
  });

  it("accepts a one-night extension even when the added night alone would fail the minimum", async () => {
    asMember();
    // The whole stay clears the minimum (default mock), which is the point:
    // the added Friday night on its own would violate a weekend 2-night rule,
    // but [2026-08-14, 2026-08-19] is a five-night contiguous stay.
    const res = await POST(req({ checkOut: "2026-08-19" }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.minimumStayValid).toBe(true);
    expect(body.minimumStayViolations).toEqual([]);
  });

  it("still reports a genuinely-short whole stay", async () => {
    asMember();
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [
        {
          policyName: "Weekend minimum",
          triggerDay: "2026-08-19",
          minimumNights: 7,
          actualNights: 6,
        },
      ],
    });

    const res = await POST(req({ checkOut: "2026-08-20" }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.minimumStayValid).toBe(false);
    expect(body.minimumStayViolations).toHaveLength(1);
    expect(body.minimumStayViolations[0].policyName).toBe("Weekend minimum");
  });

  it("skips the minimum-stay check entirely for an admin actor", async () => {
    // Default beforeEach actor is ADMIN.
    const res = await POST(req({ checkOut: "2026-08-20" }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.minimumStayValid).toBe(true);
    expect(h.validateMinimumStay).not.toHaveBeenCalled();
  });

  it("still runs the capacity check over the extension nights — no bypass", async () => {
    asMember();

    const res = await POST(req({ checkOut: "2026-08-20" }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capacityAvailable).toBe(true);
    expect(h.checkCapacityForGuestRanges).toHaveBeenCalledTimes(1);
    // The capacity range runs through the extended check-out.
    const call = h.checkCapacityForGuestRanges.mock.calls[0];
    expect((call[2] as Date).getTime()).toBe(D("2026-08-20").getTime());
  });

  it("hard-blocks the save when the extension is over capacity", async () => {
    asMember();
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [{ date: D("2026-08-19"), availableBeds: -1 }],
    });

    const res = await POST(req({ checkOut: "2026-08-20" }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capacityAvailable).toBe(false);
  });

  it("leaves the future (pre-stay) edit validating its own requested range", async () => {
    asMember();
    h.bookingFindUnique.mockResolvedValue(futureBooking());

    const res = await POST(req({ checkOut: "2026-09-05" }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.minimumStayValid).toBe(true);
    expect(h.validateMinimumStay).toHaveBeenCalledTimes(1);
    const [checkInArg, checkOutArg] = h.validateMinimumStay.mock.calls[0];
    // Future edit: the requested range (unchanged check-in → new check-out).
    expect((checkInArg as Date).getTime()).toBe(D("2026-09-01").getTime());
    expect((checkOutArg as Date).getTime()).toBe(D("2026-09-05").getTime());
  });
});
