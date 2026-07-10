import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";

const h = vi.hoisted(() => ({
  checkCapacityForGuestRanges: vi.fn(),
}));

// Keep the real OverCapacityConfirmationRequiredError + overCapacityNights so the
// thrown class is the genuine one; only stub the DB-backed capacity query.
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return { ...actual, checkCapacityForGuestRanges: h.checkCapacityForGuestRanges };
});

vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  applyMembershipTypeRatePolicyToGuests: vi
    .fn()
    .mockImplementation((_tx: unknown, { guests }: { guests: unknown[] }) =>
      Promise.resolve(guests),
    ),
  MembershipTypeBookingPolicyError: class extends Error {},
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { calculateModifiedPricing } from "@/lib/booking-modify-plan";
import {
  applyMembershipTypeRatePolicyToGuests,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

function baseArgs() {
  const guest = {
    id: "g1",
    ageTier: "ADULT",
    isMember: true,
    memberId: "m1",
    stayStart: D("2026-09-10"),
    stayEnd: D("2026-09-13"),
    priceCents: 30000,
  };
  const booking = {
    id: "b1",
    memberId: "m1",
    lodgeId: "lodge-1",
    checkIn: D("2026-09-10"),
    checkOut: D("2026-09-13"),
    totalPriceCents: 30000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 30000,
    guests: [guest],
  } as never;

  return {
    booking,
    bookingId: "b1",
    isInProgressEdit: false,
    editableFrom: null,
    newCheckIn: D("2026-09-10"),
    newCheckOut: D("2026-09-13"),
    normalizedAddGuests: undefined,
    removeGuestIds: undefined,
    guestsForPricing: [
      {
        bookingGuestId: "g1",
        ageTier: "ADULT" as const,
        isMember: true,
        memberId: "m1",
        stayStart: D("2026-09-10"),
        stayEnd: D("2026-09-13"),
      },
    ],
    skipBookingLifecycleRules: false,
    seasonRateData: [],
  };
}

const OVER_CAPACITY = {
  available: false,
  minAvailable: -1,
  nightDetails: [{ date: D("2026-09-11"), occupiedBeds: 30, availableBeds: -1 }],
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("calculateModifiedPricing capacity (issue #1668)", () => {
  it("throws the existing 400 for a non-admin over-capacity edit", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(OVER_CAPACITY);

    await expect(
      calculateModifiedPricing({} as never, {
        ...baseArgs(),
        adminOverride: false,
      }),
    ).rejects.toMatchObject({
      constructor: ApiError,
      status: 400,
      message: "Not enough beds available for these changes",
    });
  });

  it("throws OverCapacityConfirmationRequiredError for an admin override without confirm", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(OVER_CAPACITY);

    await expect(
      calculateModifiedPricing({} as never, {
        ...baseArgs(),
        adminOverride: true,
        confirmOverCapacity: false,
      }),
    ).rejects.toBeInstanceOf(OverCapacityConfirmationRequiredError);
  });

  it("proceeds with capacityOverridden: true for a confirmed admin override", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(OVER_CAPACITY);
    vi.mocked(applyMembershipTypeRatePolicyToGuests).mockImplementation(
      ((_tx: unknown, { guests }: { guests: unknown[] }) =>
        Promise.resolve(guests)) as never,
    );
    const breakdown = {
      totalPriceCents: 32000,
      guests: [
        {
          priceCents: 32000,
          perNightCents: [16000, 16000],
          nightDates: [D("2026-09-10"), D("2026-09-11")],
        },
      ],
    };
    vi.mocked(priceBookingGuestsWithMembershipTypePolicy).mockResolvedValue(
      breakdown as never,
    );
    const tx = {
      groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    } as never;

    const result = await calculateModifiedPricing(tx, {
      ...baseArgs(),
      adminOverride: true,
      confirmOverCapacity: true,
    });

    expect(result.capacityOverridden).toBe(true);
    expect(result.newTotalPriceCents).toBe(32000);
  });
});
