/**
 * #4199: the one reading of the booking editor's date controls, shared by the
 * modification payload and the promo card. Frozen clock discipline: every date
 * is a fixed August 2026 lodge night, after the 2026-07-01 freeze.
 */
import { describe, expect, it } from "vitest";
import { buildEditGuestStays } from "@/components/edit-booking/guest-stay-payload";
import type { Guest, NewGuest } from "@/components/edit-booking/types";

const booking = { checkIn: "2026-08-10", checkOut: "2026-08-13" };
const gapped: Guest = {
  id: "bg-gap",
  firstName: "Gap",
  lastName: "Guest",
  ageTier: "ADULT",
  isMember: false,
  stayStart: "2026-08-10",
  stayEnd: "2026-08-13",
  nights: ["2026-08-10", "2026-08-12"],
  priceCents: 0,
};
const added: NewGuest = {
  key: "k1",
  firstName: "New",
  lastName: "Guest",
  ageTier: "ADULT",
  isMember: false,
};

function build(overrides: Partial<Parameters<typeof buildEditGuestStays>[0]>) {
  return buildEditGuestStays({
    multiDateRangesEnabled: false,
    perGuestDatesEnabled: false,
    isInProgressEdit: false,
    booking,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    remainingGuests: [gapped],
    addedGuests: [added],
    existingGuestNights: { "bg-gap": ["2026-08-10", "2026-08-12"] },
    getExistingGuestRange: (guest) => ({
      stayStart: guest.stayStart ?? booking.checkIn,
      stayEnd: guest.stayEnd ?? booking.checkOut,
    }),
    ...overrides,
  });
}

describe("buildEditGuestStays", () => {
  it("grid mode sends each guest's night set, and the envelope around them", () => {
    const stays = build({
      multiDateRangesEnabled: true,
      addedGuests: [{ ...added, nights: ["2026-08-13"] }],
    });
    expect(stays.existing).toEqual([{ guestId: "bg-gap", nights: ["2026-08-10", "2026-08-12"] }]);
    expect(stays.added).toEqual([{ nights: ["2026-08-13"] }]);
    expect(stays.checkIn).toBe("2026-08-10");
    expect(stays.checkOut).toBe("2026-08-14");
  });

  it("grid mode wins over per-guest dates", () => {
    const stays = build({ multiDateRangesEnabled: true, perGuestDatesEnabled: true });
    expect(stays.existing?.[0]).toEqual({ guestId: "bg-gap", nights: ["2026-08-10", "2026-08-12"] });
    expect(stays.added).toEqual([{ nights: ["2026-08-10", "2026-08-11", "2026-08-12"] }]);
  });

  it("range mode sends continuous dates, which a save charges as shown (#4189)", () => {
    const stays = build({ perGuestDatesEnabled: true });
    expect(stays.existing).toEqual([{ guestId: "bg-gap", stayStart: "2026-08-10", stayEnd: "2026-08-13" }]);
    expect(stays.added).toEqual([{ stayStart: "2026-08-10", stayEnd: "2026-08-13" }]);
  });

  it("with neither switch on, no stays are sent and the dates are the editor's", () => {
    const stays = build({ checkIn: "2026-08-11", checkOut: "2026-08-14" });
    expect(stays).toEqual({ checkIn: "2026-08-11", checkOut: "2026-08-14", existing: null, added: [{}] });
  });

  it("an in-progress edit never sends stays", () => {
    const stays = build({ multiDateRangesEnabled: true, perGuestDatesEnabled: true, isInProgressEdit: true });
    expect(stays.existing).toBeNull();
  });
});
