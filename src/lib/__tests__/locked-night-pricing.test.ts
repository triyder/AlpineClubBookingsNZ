/**
 * Locked nightly pricing (#1036, Option 1): nights a guest already bought
 * keep the price stored on their BookingGuestNight rows; edits price only the
 * changed guests/nights at current season rates. The matrix crosses a rate
 * increase and a rate decrease with add-guest, remove-guest, extend-dates,
 * and shorten-dates shapes, asserting unchanged nights never move.
 */
import { describe, expect, it } from "vitest";
import {
  calculateBookingPrice,
  type SeasonRateData,
} from "@/lib/policies/pricing";

const CHECK_IN = new Date("2026-07-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-07-05T00:00:00.000Z"); // 4 nights

function season(adultMemberRate: number): SeasonRateData[] {
  return [
    {
      seasonId: "s1",
      startDate: new Date("2026-06-01T00:00:00.000Z"),
      endDate: new Date("2026-08-31T00:00:00.000Z"),
      rates: [
        { ageTier: "ADULT", isMember: true, pricePerNightCents: adultMemberRate },
        { ageTier: "ADULT", isMember: false, pricePerNightCents: adultMemberRate + 2000 },
      ],
    },
  ];
}

/** A guest booked at 5000/night for the original 4 nights. */
function lockedGuest() {
  return {
    ageTier: "ADULT" as const,
    isMember: true,
    memberId: "m1",
    lockedNightPrices: [
      { stayDate: new Date("2026-07-01T00:00:00.000Z"), priceCents: 5000 },
      { stayDate: new Date("2026-07-02T00:00:00.000Z"), priceCents: 5000 },
      { stayDate: new Date("2026-07-03T00:00:00.000Z"), priceCents: 5000 },
      { stayDate: new Date("2026-07-04T00:00:00.000Z"), priceCents: 5000 },
    ],
  };
}

describe.each([
  ["rate increase", 6000],
  ["rate decrease", 4000],
])("locked night pricing across a %s (current rate %i)", (_label, currentRate) => {
  const seasons = season(currentRate);

  it("adding a guest costs exactly the added guest's own current-rate price", () => {
    const price = calculateBookingPrice(
      CHECK_IN,
      CHECK_OUT,
      [
        lockedGuest(),
        lockedGuest(),
        { ageTier: "ADULT", isMember: true, memberId: "m3" }, // new guest
      ],
      seasons,
    );

    // Unchanged guests never move.
    expect(price.guests[0].perNightCents).toEqual([5000, 5000, 5000, 5000]);
    expect(price.guests[1].perNightCents).toEqual([5000, 5000, 5000, 5000]);
    // The new guest prices at the current rate.
    expect(price.guests[2].priceCents).toBe(currentRate * 4);
    expect(price.totalPriceCents).toBe(40000 + currentRate * 4);
  });

  it("removing a guest changes the total by exactly that guest's booked price", () => {
    const price = calculateBookingPrice(CHECK_IN, CHECK_OUT, [lockedGuest()], seasons);

    expect(price.guests[0].perNightCents).toEqual([5000, 5000, 5000, 5000]);
    expect(price.totalPriceCents).toBe(20000);
  });

  it("extending the stay prices only the added night at current rates", () => {
    const price = calculateBookingPrice(
      CHECK_IN,
      new Date("2026-07-06T00:00:00.000Z"), // +1 night
      [lockedGuest()],
      seasons,
    );

    expect(price.guests[0].perNightCents).toEqual([
      5000,
      5000,
      5000,
      5000,
      currentRate,
    ]);
    expect(price.totalPriceCents).toBe(20000 + currentRate);
  });

  it("shortening the stay keeps every remaining night at its booked price", () => {
    const price = calculateBookingPrice(
      CHECK_IN,
      new Date("2026-07-04T00:00:00.000Z"), // -1 night
      [lockedGuest()],
      seasons,
    );

    expect(price.guests[0].perNightCents).toEqual([5000, 5000, 5000]);
    expect(price.totalPriceCents).toBe(15000);
  });
});

describe("locked night pricing edge cases", () => {
  it("legacy guests without stored night rows price at current rates", () => {
    const price = calculateBookingPrice(
      CHECK_IN,
      CHECK_OUT,
      [{ ageTier: "ADULT", isMember: true, memberId: "m1" }],
      season(6000),
    );

    expect(price.guests[0].priceCents).toBe(24000);
  });

  it("a fully locked night set never needs a season rate", () => {
    // The guest's tier no longer has a rate (e.g. the rate row was removed);
    // their bought nights still price from the locked rows instead of
    // throwing "No rate found" (#1032's hard-failure variant, ordinary-booking
    // side).
    const price = calculateBookingPrice(CHECK_IN, CHECK_OUT, [lockedGuest()], []);

    expect(price.guests[0].priceCents).toBe(20000);
  });

  it("still throws for an unlocked night with no season rate", () => {
    expect(() =>
      calculateBookingPrice(
        CHECK_IN,
        new Date("2026-07-06T00:00:00.000Z"),
        [lockedGuest()],
        [],
      ),
    ).toThrow(/No rate found/);
  });

  it("group discount does not disturb locked nights", () => {
    // 4 non-member guests would qualify for the member-rate group discount on
    // unlocked nights; the locked guests keep their stored 5000 regardless.
    const nonMemberLocked = {
      ageTier: "ADULT" as const,
      isMember: false,
      memberId: null,
      lockedNightPrices: lockedGuest().lockedNightPrices,
    };
    const price = calculateBookingPrice(
      CHECK_IN,
      CHECK_OUT,
      [nonMemberLocked, nonMemberLocked, nonMemberLocked, nonMemberLocked],
      season(6000),
      { enabled: true, minGroupSize: 4, summerOnly: false },
    );

    for (const guest of price.guests) {
      expect(guest.perNightCents).toEqual([5000, 5000, 5000, 5000]);
    }
  });

  it("locks apply per matching date, not positionally", () => {
    // A guest with a gap: locked rows for the 1st and 3rd nights only.
    const price = calculateBookingPrice(
      CHECK_IN,
      CHECK_OUT,
      [
        {
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m1",
          nights: [
            new Date("2026-07-01T00:00:00.000Z"),
            new Date("2026-07-03T00:00:00.000Z"),
            new Date("2026-07-04T00:00:00.000Z"),
          ],
          lockedNightPrices: [
            { stayDate: new Date("2026-07-01T00:00:00.000Z"), priceCents: 5000 },
            { stayDate: new Date("2026-07-03T00:00:00.000Z"), priceCents: 5500 },
          ],
        },
      ],
      season(6000),
    );

    expect(price.guests[0].perNightCents).toEqual([5000, 5500, 6000]);
  });
});
