import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The #1095-class risk this feature carries: the modify-quote preview and the
// apply service resolve dates through two code paths, so an admin-override
// recalc must lift the in-progress check-in lock on the PREVIEW side exactly as
// the apply side does (proven for apply in resolve-target-dates-admin-override).
// This drives the quote route and asserts: (a) without the override, moving an
// in-progress booking's check-in is refused with the lock error, and (b) the
// same move under a recalculate override is accepted and returns a coherent
// non-zero price delta — i.e. the lock is lifted and pricing runs.

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
  applyMembershipTypeRatePolicyToGuests: vi
    .fn()
    .mockImplementation((_db: unknown, { guests }: { guests: unknown[] }) =>
      Promise.resolve(guests),
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
// Xero lock-date guard chain (#1697). getEffectiveXeroLockDate stays real.
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
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { POST } from "@/app/api/bookings/[id]/modify-quote/route";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

// A fixed NZ "today" well inside the booking's stay, with multi-day margins so
// the Pacific/Auckland date-only normalization can never flip the edit-policy
// branch (a TZ-offset of hours cannot cross a several-day gap).
const NOW = new Date("2026-08-15T06:00:00.000Z");

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

// In-progress booking (check-in 2026-08-14 <= today 2026-08-15 < check-out
// 2026-08-18). Season-priced at 30000c originally over four nights.
function booking() {
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "admin1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("ADMIN");
  h.bookingFindUnique.mockResolvedValue(booking());
  h.seasonFindMany.mockResolvedValue([]);
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
  // Repricing the moved stay yields a higher total than booked → non-zero delta.
  h.priceGuests.mockResolvedValue({
    totalPriceCents: 40000,
    guests: [{ priceCents: 40000, perNightCents: [], nightDates: [] }],
  });
  h.calculateChangeFee.mockReturnValue({ feeCents: 0 });
  // Guard dormant by default; the #1697 cases arm it explicitly.
  h.loadModuleFlags.mockResolvedValue({ xeroIntegration: false });
  h.isXeroConnected.mockResolvedValue(true);
  h.getXeroLockDates.mockResolvedValue({
    periodLockDate: null,
    endOfYearLockDate: null,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /api/bookings/[id]/modify-quote recalc override (issue #1668)", () => {
  it("refuses to move an in-progress check-in WITHOUT the override (lock present)", async () => {
    const res = await POST(req({ checkIn: "2026-08-12" }), { params });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Check-in cannot be changed for an in-progress booking",
    });
  });

  it("lifts the check-in lock under a recalculate override and prices the move", async () => {
    const res = await POST(
      req({
        adminOverride: true,
        pricingMode: "recalculate",
        checkIn: "2026-08-12",
      }),
      { params },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Lock lifted (no 400) and the repriced move surfaces a coherent delta.
    expect(body.priceDiffCents).toBe(10000);
    expect(body.newFinalPriceCents).toBe(40000);
    expect(body.capacityAvailable).toBe(true);
  });
});

describe("POST /api/bookings/[id]/modify-quote Xero lock-date guard (issue #1697)", () => {
  const armLock = (lockDate: string | null) => {
    h.loadModuleFlags.mockResolvedValue({ xeroIntegration: true });
    h.getXeroLockDates.mockResolvedValue({
      periodLockDate: lockDate ? D(lockDate) : null,
      endOfYearLockDate: null,
    });
  };

  it("rejects a recalc-override preview whose new check-in is on/before the lock date (409 + code)", async () => {
    armLock("2026-08-13");

    const res = await POST(
      req({
        adminOverride: true,
        pricingMode: "recalculate",
        checkIn: "2026-08-12",
      }),
      { params },
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "XERO_PERIOD_LOCKED",
      lockDate: "2026-08-13",
    });
    // Rejected before pricing: the preview never shows a quote apply cannot deliver.
    expect(h.priceGuests).not.toHaveBeenCalled();
  });

  it("guards a check-out-only recalc override via the booking's unchanged past check-in", async () => {
    armLock("2026-08-14");

    const res = await POST(
      req({
        adminOverride: true,
        pricingMode: "recalculate",
        checkOut: "2026-08-20",
      }),
      { params },
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "XERO_PERIOD_LOCKED",
    });
  });

  it("fails closed with 503 when the lock dates cannot be read", async () => {
    h.loadModuleFlags.mockResolvedValue({ xeroIntegration: true });
    h.getXeroLockDates.mockRejectedValue(new Error("xero down"));

    const res = await POST(
      req({
        adminOverride: true,
        pricingMode: "recalculate",
        checkIn: "2026-08-12",
      }),
      { params },
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: "XERO_LOCK_DATE_CHECK_FAILED",
    });
  });

  it("previews normally when the past check-in clears the lock date", async () => {
    armLock("2026-08-10");

    const res = await POST(
      req({
        adminOverride: true,
        pricingMode: "recalculate",
        checkIn: "2026-08-12",
      }),
      { params },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceDiffCents).toBe(10000);
  });

  it("never consults the lock dates for a shift override (shift writes no Xero documents)", async () => {
    armLock("2026-08-13");

    const res = await POST(
      req({
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2026-08-12",
        checkOut: "2026-08-16",
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
    expect(h.loadModuleFlags).not.toHaveBeenCalled();
  });
});
