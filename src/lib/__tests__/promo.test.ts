import { describe, it, expect } from "vitest";
import {
  calculatePromoDiscountForGuestRates,
  validatePromoCodeRules,
  type PromoRuleSubject,
} from "../promo";
import { calculatePromoDiscount, type PromoCodeInput } from "../pricing";

// --- Test helpers ---

function makePromoCode(overrides: Partial<PromoRuleSubject> = {}): PromoRuleSubject {
  return {
    id: "promo-1",
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptionsTotal: null,
    currentRedemptions: 0,
    membersOnly: false,
    maxUsesPerMember: null,
    maxUniqueMembersTotal: null,
    ...overrides,
  };
}

const defaultBookingDetails = { memberId: "member-1" };
const now = new Date("2026-07-15T12:00:00Z");

const singleMemberGuest = [
  { memberId: "member-1", isMember: true, perNightRates: [5000, 5000, 5000] },
];

// --- Validation Rule Tests ---

describe("validatePromoCodeRules", () => {
  it("returns null for a valid promo code", () => {
    expect(validatePromoCodeRules(makePromoCode(), defaultBookingDetails, now)).toBeNull();
  });

  it("returns error when promo code is null (not found)", () => {
    expect(validatePromoCodeRules(null, defaultBookingDetails, now)).toBe("Promo code not found");
  });

  it("returns error when promo code is inactive", () => {
    expect(validatePromoCodeRules(makePromoCode({ active: false }), defaultBookingDetails, now)).toBe(
      "This promo code is no longer active"
    );
  });

  it("returns error when promo code is not yet valid", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ validFrom: new Date("2026-08-01") }),
        defaultBookingDetails,
        now
      )
    ).toBe("This promo code is not yet valid");
  });

  it("allows promo code on exact validFrom date", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ validFrom: new Date("2026-07-15T00:00:00Z") }),
        defaultBookingDetails,
        new Date("2026-07-15T12:00:00Z")
      )
    ).toBeNull();
  });

  it("returns error when promo code has expired", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ validUntil: new Date("2026-07-01") }),
        defaultBookingDetails,
        now
      )
    ).toBe("This promo code has expired");
  });

  it("allows promo code before validUntil", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ validUntil: new Date("2026-12-31") }),
        defaultBookingDetails,
        now
      )
    ).toBeNull();
  });

  it("returns error when total redemptions cap reached", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxRedemptionsTotal: 10, currentRedemptions: 10 }),
        defaultBookingDetails,
        now
      )
    ).toBe("This promo code has reached its maximum number of uses");
  });

  it("allows when redemptions below cap", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxRedemptionsTotal: 10, currentRedemptions: 9 }),
        defaultBookingDetails,
        now
      )
    ).toBeNull();
  });

  it("allows unlimited redemptions when cap is null", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxRedemptionsTotal: null, currentRedemptions: 999 }),
        defaultBookingDetails,
        now
      )
    ).toBeNull();
  });

  it("returns error for members-only code with no memberId", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ membersOnly: true }),
        { memberId: "" },
        now
      )
    ).toBe("This promo code is only available to members");
  });

  it("allows members-only code for a member", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ membersOnly: true }),
        defaultBookingDetails,
        now
      )
    ).toBeNull();
  });

  it("returns 'already used' error when maxUsesPerMember is 1 and member already redeemed", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUsesPerMember: 1 }),
        defaultBookingDetails,
        now,
        { memberRedemptionCount: 1 }
      )
    ).toBe("You have already used this promo code");
  });

  it("returns 'max uses reached' error when maxUsesPerMember > 1 and member has used all", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUsesPerMember: 3 }),
        defaultBookingDetails,
        now,
        { memberRedemptionCount: 3 }
      )
    ).toBe("You have reached the maximum uses of this promo code");
  });

  it("allows additional use when below maxUsesPerMember cap", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUsesPerMember: 3 }),
        defaultBookingDetails,
        now,
        { memberRedemptionCount: 2 }
      )
    ).toBeNull();
  });

  it("checks expired before total cap", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({
          active: true,
          validUntil: new Date("2026-01-01"),
          maxRedemptionsTotal: 0,
          currentRedemptions: 0,
        }),
        defaultBookingDetails,
        now
      )
    ).toBe("This promo code has expired");
  });

  it("checks inactive before expired", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ active: false, validUntil: new Date("2026-01-01") }),
        defaultBookingDetails,
        now
      )
    ).toBe("This promo code is no longer active");
  });
});

// --- maxUniqueMembersTotal Validation Tests ---

describe("validatePromoCodeRules - maxUniqueMembersTotal", () => {
  it("rejects new member when unique-members cap reached", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUniqueMembersTotal: 5 }),
        defaultBookingDetails,
        now,
        { uniqueMembersUsed: 5, memberHasRedeemedBefore: false }
      )
    ).toBe("This promo code has reached its maximum number of unique members");
  });

  it("allows existing member to redeem again even when unique-members cap is full", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUniqueMembersTotal: 5, maxUsesPerMember: 3 }),
        defaultBookingDetails,
        now,
        {
          uniqueMembersUsed: 5,
          memberHasRedeemedBefore: true,
          memberRedemptionCount: 1,
        }
      )
    ).toBeNull();
  });

  it("allows new member when below unique-members cap", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUniqueMembersTotal: 5 }),
        defaultBookingDetails,
        now,
        { uniqueMembersUsed: 4, memberHasRedeemedBefore: false }
      )
    ).toBeNull();
  });

  it("ignores unique-members cap when null", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ maxUniqueMembersTotal: null }),
        defaultBookingDetails,
        now,
        { uniqueMembersUsed: 99999, memberHasRedeemedBefore: false }
      )
    ).toBeNull();
  });
});

// --- Cumulative Free Nights Validation Tests ---

describe("validatePromoCodeRules - cumulative free nights", () => {
  it("returns error when all free nights have been consumed", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ type: "FREE_NIGHTS", freeNightsPerIndividual: 4 }),
        defaultBookingDetails,
        now,
        { memberFreeNightsUsed: 4 }
      )
    ).toBe("You have used all your free nights for this promo code");
  });

  it("returns error when free nights exceed allowance", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ type: "FREE_NIGHTS", freeNightsPerIndividual: 4 }),
        defaultBookingDetails,
        now,
        { memberFreeNightsUsed: 5 }
      )
    ).toBe("You have used all your free nights for this promo code");
  });

  it("allows when some free nights remain", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ type: "FREE_NIGHTS", freeNightsPerIndividual: 4 }),
        defaultBookingDetails,
        now,
        { memberFreeNightsUsed: 2 }
      )
    ).toBeNull();
  });

  it("does not check free nights for non-FREE_NIGHTS promos", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ type: "PERCENTAGE" }),
        defaultBookingDetails,
        now,
        { memberFreeNightsUsed: 100 }
      )
    ).toBeNull();
  });

  it("does not check free nights when freeNightsPerIndividual is null", () => {
    expect(
      validatePromoCodeRules(
        makePromoCode({ type: "FREE_NIGHTS", freeNightsPerIndividual: null }),
        defaultBookingDetails,
        now,
        { memberFreeNightsUsed: 10 }
      )
    ).toBeNull();
  });
});

// --- Discount calculation: PERCENTAGE (per individual) ---

describe("calculatePromoDiscount - PERCENTAGE per individual", () => {
  it("20% off one guest's nights", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 20 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 10000,
      guests: [{ memberId: null, isMember: true, perNightRates: [5000, 5000] }],
    });
    // 20% × 5000 = 1000 per night × 2 = 2000
    expect(result.discountCents).toBe(2000);
  });

  it("applies to all eligible guests when no per-booking cap", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 10 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 20000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [5000, 5000] },
        { memberId: null, isMember: true, perNightRates: [5000, 5000] },
      ],
    });
    // 10% of 20000 total = 2000
    expect(result.discountCents).toBe(2000);
    expect(result.eligibleGuestCount).toBe(2);
  });

  it("caps to maxGuestsPerBooking, picking most expensive guests", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50, maxGuestsPerBooking: 1 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 18000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [5000, 5000, 5000] }, // 15000 total
        { memberId: null, isMember: true, perNightRates: [1000, 1000, 1000] }, // 3000 total
      ],
    });
    // Picks the 15000 guest, 50% = 7500
    expect(result.discountCents).toBe(7500);
    expect(result.eligibleGuestCount).toBe(1);
  });

  it("filters non-member guests when memberGuestsOnly is true", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50, memberGuestsOnly: true };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 18000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [5000, 5000, 5000] },
        { memberId: null, isMember: false, perNightRates: [1000, 1000, 1000] },
      ],
    });
    // Only the member guest counts: 50% × 15000 = 7500
    expect(result.discountCents).toBe(7500);
    expect(result.eligibleGuestCount).toBe(1);
  });

  it("applies nightly value cap to percentage", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50, maxNightlyValueCents: 1000 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 6000,
      guests: [{ memberId: null, isMember: true, perNightRates: [3000, 3000] }],
    });
    // 50% × 3000 = 1500 per night, capped to 1000 × 2 nights = 2000
    expect(result.discountCents).toBe(2000);
  });

  it("returns 0 for 0%", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 0 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 10000,
      guests: singleMemberGuest,
    });
    expect(result.discountCents).toBe(0);
  });

  it("returns 0 for null percentOff", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: null };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 10000,
      guests: singleMemberGuest,
    });
    expect(result.discountCents).toBe(0);
  });
});

// --- Discount calculation: FIXED_AMOUNT (per individual) ---

describe("calculatePromoDiscount - FIXED_AMOUNT per individual", () => {
  it("$50 off each eligible guest", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 20000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [6000] },
        { memberId: null, isMember: true, perNightRates: [6000] },
      ],
    });
    expect(result.discountCents).toBe(10000);
    expect(result.eligibleGuestCount).toBe(2);
  });

  it("caps per-guest discount at guest's stay total", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 15000 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 10000,
      guests: [{ memberId: null, isMember: true, perNightRates: [10000] }],
    });
    expect(result.discountCents).toBe(10000);
  });

  it("limits to top maxGuestsPerBooking by stay total", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000, maxGuestsPerBooking: 1 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 15000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [10000] },
        { memberId: null, isMember: true, perNightRates: [5000] },
      ],
    });
    expect(result.discountCents).toBe(5000);
    expect(result.eligibleGuestCount).toBe(1);
  });

  it("returns 0 for zero valueCents", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 0 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 10000,
      guests: singleMemberGuest,
    });
    expect(result.discountCents).toBe(0);
  });
});

// --- Discount calculation: FREE_NIGHTS (per individual) ---

describe("calculatePromoDiscount - FREE_NIGHTS per individual", () => {
  it("frees the most expensive nights for each eligible guest", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 2 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 24000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [4500, 4500, 4500] },
        { memberId: null, isMember: true, perNightRates: [4500, 4500, 4500] },
      ],
    });
    // 2 most expensive per guest × 4500 × 2 guests = 18000
    expect(result.discountCents).toBe(18000);
    expect(result.freeNightsUsed).toBe(4);
  });

  it("respects maxGuestsPerBooking - picks most expensive guests first", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 2, maxGuestsPerBooking: 1 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 24000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [4500, 4500, 4500] }, // 13500 total
        { memberId: null, isMember: true, perNightRates: [1000, 1000, 1000] }, // 3000 total
      ],
    });
    // Only top guest: 2 most expensive nights = 4500 + 4500 = 9000
    expect(result.discountCents).toBe(9000);
    expect(result.freeNightsUsed).toBe(2);
    expect(result.eligibleGuestCount).toBe(1);
  });

  it("respects lifetime cap as a single pool across selected guests", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 3 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 18000,
      guests: [
        { memberId: null, isMember: true, perNightRates: [4500, 4500, 4500] },
        { memberId: null, isMember: true, perNightRates: [4500] },
      ],
      remainingFreeNights: 2,
    });
    // Booker only has 2 left from their lifetime budget; pick the 2 most expensive
    // candidate nights across the selected guests' top-3-each candidate pools.
    expect(result.discountCents).toBe(9000);
    expect(result.freeNightsUsed).toBe(2);
  });

  it("returns 0 when lifetime cap is exhausted", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 3 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 18000,
      guests: singleMemberGuest,
      remainingFreeNights: 0,
    });
    expect(result.discountCents).toBe(0);
    expect(result.freeNightsUsed).toBe(0);
  });

  it("applies nightly value cap as partial subsidy", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 3, maxNightlyValueCents: 3000 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 24000,
      guests: [{ memberId: null, isMember: true, perNightRates: [8000, 8000, 8000] }],
    });
    // 3 nights at 8000 capped to 3000 each = 9000
    expect(result.discountCents).toBe(9000);
    expect(result.freeNightsUsed).toBe(3);
  });

  it("filters non-member guests when memberGuestsOnly is true", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 2, memberGuestsOnly: true };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 18000,
      guests: [
        { memberId: null, isMember: false, perNightRates: [4500, 4500, 4500] },
        { memberId: null, isMember: true, perNightRates: [4500, 4500, 4500] },
      ],
    });
    // Non-member guest excluded; 2 free nights for the one member = 9000
    expect(result.discountCents).toBe(9000);
    expect(result.freeNightsUsed).toBe(2);
    expect(result.eligibleGuestCount).toBe(1);
  });

  it("returns 0 when no eligible guests", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 2, memberGuestsOnly: true };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 9000,
      guests: [{ memberId: null, isMember: false, perNightRates: [4500, 4500] }],
    });
    expect(result.discountCents).toBe(0);
  });

  it("returns 0 for zero freeNightsPerIndividual", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 0 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 18000,
      guests: singleMemberGuest,
    });
    expect(result.discountCents).toBe(0);
  });
});

// --- calculatePromoDiscountForGuestRates (the booking-time wrapper) ---

describe("calculatePromoDiscountForGuestRates", () => {
  it("scopes assigned free-night promos to the assigned member's own guest nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 1 };
    const result = calculatePromoDiscountForGuestRates(
      promo,
      7000,
      "member-1",
      [
        { memberId: "member-1", isMember: true, perNightRates: [5000] },
        { memberId: "member-2", isMember: true, perNightRates: [2000] },
      ],
      ["member-1"]
    );
    expect(result.discountCents).toBe(5000);
  });

  it("includes all guests for unassigned free-night promos", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 1 };
    const result = calculatePromoDiscountForGuestRates(
      promo,
      7000,
      "member-1",
      [
        { memberId: "member-1", isMember: true, perNightRates: [5000] },
        { memberId: "member-2", isMember: true, perNightRates: [2000] },
      ],
      null
    );
    // Both guests get 1 night free = 5000 + 2000 = 7000
    expect(result.discountCents).toBe(7000);
  });

  it("returns 0 when assigned member is not a guest", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 1 };
    const result = calculatePromoDiscountForGuestRates(
      promo,
      4000,
      "member-1",
      [{ memberId: "member-2", isMember: true, perNightRates: [2000, 2000] }],
      ["member-1"]
    );
    expect(result.discountCents).toBe(0);
  });

  it("passes remainingFreeNights through to limit free nights", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 4 };
    const result = calculatePromoDiscountForGuestRates(
      promo,
      15000,
      "member-1",
      [{ memberId: "member-1", isMember: true, perNightRates: [5000, 5000, 5000] }],
      ["member-1"],
      2
    );
    expect(result.discountCents).toBe(10000);
    expect(result.freeNightsUsed).toBe(2);
  });
});

// --- Edge cases ---

describe("edge cases", () => {
  it("returns 0 for an empty guest list", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50 };
    const result = calculatePromoDiscount(promo, { totalPriceCents: 0, guests: [] });
    expect(result.discountCents).toBe(0);
  });

  it("discount on zero total (PERCENTAGE)", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 0,
      guests: [{ memberId: null, isMember: true, perNightRates: [0] }],
    });
    expect(result.discountCents).toBe(0);
  });

  it("discount on zero total (FIXED_AMOUNT) is capped at 0", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 0,
      guests: [{ memberId: null, isMember: true, perNightRates: [0] }],
    });
    expect(result.discountCents).toBe(0);
  });
});
