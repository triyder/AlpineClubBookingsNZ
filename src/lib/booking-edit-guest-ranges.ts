import type { AgeTier } from "@prisma/client";
import {
  calculateBookingPrice,
  type RateSource,
  type SeasonRateData,
} from "@/lib/pricing";
import { normalizeDateOnlyForTimeZone } from "@/lib/date-only";

interface ExistingBookingEditGuest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  // Resolved rate membership type (#1930, E4); replaces the old
  // forceNonMemberRate boolean. Range pricing here never applies a group
  // discount, so rateSource is carried only for shape parity.
  rateMembershipTypeId: string;
  rateSource?: RateSource;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  priceCents: number;
}

interface AddedBookingEditGuest {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  rateMembershipTypeId: string;
  rateSource?: RateSource;
}

interface ProposedExistingGuestRange {
  guest: ExistingBookingEditGuest;
  stayStart: Date;
  stayEnd: Date;
  priceCents: number;
  oldFuturePriceCents: number;
  newFuturePriceCents: number;
  futureDeltaCents: number;
  removedFromFuture: boolean;
  // #2029: the earliest night this edit newly prices/occupies for the guest —
  // `maxDate(stayStart, minDate(editableFrom, originalStayEnd))`. Equals
  // editableFrom for the mid-stay/last-night cases, but drops back to the
  // guest's own (original) stay end for a check-out-day extension so the
  // genuinely-new [stayEnd, editableFrom) night is both charged and
  // capacity-checked. Both the pricing delta and the capacity range key off it.
  futureStart: Date;
}

interface ProposedAddedGuestRange {
  guest: AddedBookingEditGuest;
  stayStart: Date;
  stayEnd: Date;
  priceCents: number;
}

export interface BookingEditGuestRangePlan {
  proposedExistingGuests: ProposedExistingGuestRange[];
  proposedAddedGuests: ProposedAddedGuestRange[];
  remainingGuests: ExistingBookingEditGuest[];
  removedGuests: ExistingBookingEditGuest[];
  newTotalPriceCents: number;
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  newFinalPriceCents: number;
  priceDiffCents: number;
  futureExistingDeltaCents: number;
  futureActiveGuestCount: number;
  capacityGuestRanges: Array<{
    stayStart: Date;
    stayEnd: Date;
    // Carried so the partner-shared admission check (#1746) can tell a
    // flagged sharer's range from the ordinary ones; null for non-members.
    memberId?: string | null;
  }>;
  // #2029: the earliest night the capacity check must cover for this edit — the
  // minimum `futureStart` across the included ranges, never later than
  // editableFrom. The capacity call sites use this (not editableFrom) as the
  // window start so a check-out-day extension's new night is inside the checked
  // window; for mid-stay/last-night edits it equals editableFrom (unchanged).
  capacityRangeStart: Date;
}

export interface BuildInProgressGuestRangePlanInput {
  booking: {
    checkIn: Date;
    checkOut: Date;
    totalPriceCents: number;
    discountCents: number;
    promoAdjustmentCents: number;
    finalPriceCents: number;
    guests: ExistingBookingEditGuest[];
  };
  editableFrom: Date;
  newCheckOut: Date;
  addGuests?: AddedBookingEditGuest[];
  removeGuestIds?: string[];
  seasons: SeasonRateData[];
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}

function priceGuestRangeCents(
  start: Date,
  end: Date,
  guest: Pick<
    ExistingBookingEditGuest,
    "ageTier" | "isMember" | "rateMembershipTypeId" | "rateSource"
  >,
  seasons: SeasonRateData[]
): number {
  const normalizedStart = normalizeDateOnlyForTimeZone(start);
  const normalizedEnd = normalizeDateOnlyForTimeZone(end);
  if (normalizedEnd <= normalizedStart) {
    return 0;
  }

  return calculateBookingPrice(
    normalizedStart,
    normalizedEnd,
    [{
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      rateMembershipTypeId: guest.rateMembershipTypeId,
      rateSource: guest.rateSource,
    }],
    seasons
  ).totalPriceCents;
}

export function buildInProgressGuestRangePlan(
  input: BuildInProgressGuestRangePlanInput
): BookingEditGuestRangePlan {
  const editableFrom = normalizeDateOnlyForTimeZone(input.editableFrom);
  const bookingCheckIn = normalizeDateOnlyForTimeZone(input.booking.checkIn);
  const bookingCheckOut = normalizeDateOnlyForTimeZone(input.booking.checkOut);
  const newCheckOut = normalizeDateOnlyForTimeZone(input.newCheckOut);
  const addGuests = input.addGuests ?? [];
  const removeSet = new Set(input.removeGuestIds ?? []);

  if (newCheckOut < editableFrom) {
    throw new Error("Check-out cannot move before NZ tomorrow");
  }

  if (addGuests.length > 0 && newCheckOut <= editableFrom) {
    throw new Error("Guests can only be added when the booking has future nights");
  }

  const remainingGuests = input.booking.guests.filter((g) => !removeSet.has(g.id));
  const removedGuests = input.booking.guests.filter((g) => removeSet.has(g.id));
  const proposedExistingGuests = input.booking.guests.map((guest) => {
    const stayStart = normalizeDateOnlyForTimeZone(guest.stayStart ?? bookingCheckIn);
    const stayEnd = normalizeDateOnlyForTimeZone(guest.stayEnd ?? bookingCheckOut);
    const oldFutureStart = maxDate(stayStart, editableFrom);
    const oldFuturePriceCents = priceGuestRangeCents(
      oldFutureStart,
      stayEnd,
      guest,
      input.seasons
    );
    const removedFromFuture = removeSet.has(guest.id);
    const proposedStayEnd = removedFromFuture
      ? minDate(stayEnd, editableFrom)
      : newCheckOut;
    // #2029: the check-out-day extension the widened edit window opened adds
    // genuinely-new nights in [stayEnd, editableFrom) — a slice that sits INSIDE
    // the locked window (editableFrom = NZ tomorrow, but the guest's old stay
    // ended today). Anchoring the new-price window at editableFrom (as the
    // old-price window correctly does — nothing of the old stay is left to
    // reprice there) would drop that slice and hand those nights out free.
    // Start the new-price window at the guest's own stay end whenever it
    // precedes editableFrom, so futureDelta always equals exactly the added
    // nights [stayEnd, newCheckOut) per guest. `maxDate(stayStart, …)` keeps a
    // future-dated partial-range guest (#713) from being charged before they
    // arrive; whenever editableFrom <= stayEnd this is byte-identical to the
    // prior `maxDate(stayStart, editableFrom)` (the mid-stay / last-night case).
    const newFutureStart = maxDate(stayStart, minDate(editableFrom, stayEnd));
    const newFuturePriceCents = removedFromFuture
      ? 0
      : priceGuestRangeCents(newFutureStart, proposedStayEnd, guest, input.seasons);
    const futureDeltaCents = newFuturePriceCents - oldFuturePriceCents;

    return {
      guest,
      stayStart,
      stayEnd: proposedStayEnd,
      priceCents: guest.priceCents + futureDeltaCents,
      oldFuturePriceCents,
      newFuturePriceCents,
      futureDeltaCents,
      removedFromFuture,
      futureStart: newFutureStart,
    };
  });

  const proposedAddedGuests = addGuests.map((guest) => ({
    guest,
    stayStart: editableFrom,
    stayEnd: newCheckOut,
    priceCents: priceGuestRangeCents(editableFrom, newCheckOut, guest, input.seasons),
  }));

  // #2029: a guest is "active in the future window" when its corrected future
  // window [futureStart, proposedStayEnd) is non-empty. Using futureStart (not
  // editableFrom) folds in the check-out-day extension night, which the old
  // `maxDate(stayStart, editableFrom) < stayEnd` test dropped (proposedStayEnd
  // could equal editableFrom on a +1 extension). Byte-identical for mid-stay /
  // last-night edits, where futureStart === editableFrom.
  const futureActiveGuestCount =
    proposedExistingGuests.filter(
      (entry) => !entry.removedFromFuture && entry.futureStart < entry.stayEnd
    ).length + proposedAddedGuests.length;

  if (newCheckOut > editableFrom && futureActiveGuestCount === 0) {
    throw new Error("Booking must have at least one guest for future nights");
  }

  const newTotalPriceCents =
    proposedExistingGuests.reduce((sum, entry) => sum + entry.priceCents, 0) +
    proposedAddedGuests.reduce((sum, entry) => sum + entry.priceCents, 0);
  const newDiscountCents = input.booking.discountCents;
  const newPromoAdjustmentCents = input.booking.promoAdjustmentCents;
  const newFinalPriceCents = newTotalPriceCents + newPromoAdjustmentCents;
  const priceDiffCents = newFinalPriceCents - input.booking.finalPriceCents;
  const futureExistingDeltaCents = proposedExistingGuests.reduce(
    (sum, entry) => sum + entry.futureDeltaCents,
    0
  );
  const capacityGuestRanges = [
    ...proposedExistingGuests
      .filter(
        (entry) => !entry.removedFromFuture && entry.futureStart < entry.stayEnd
      )
      .map((entry) => ({
        // #2029: anchor the checked range at the guest's corrected futureStart,
        // not editableFrom, so the genuinely-new check-out-day night is inside
        // the window the capacity resolver iterates (it would otherwise be
        // invisible and overbookable). Unchanged for mid-stay / last-night.
        stayStart: entry.futureStart,
        stayEnd: entry.stayEnd,
        memberId: entry.guest.memberId ?? null,
      })),
    ...proposedAddedGuests.map((entry) => ({
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
      memberId: entry.guest.memberId ?? null,
    })),
  ];

  // #2029: the capacity window must start no later than the earliest checked
  // night. Seed at editableFrom (so it is never pushed later than today+1) and
  // pull it back to the earliest range start — which drops to the check-out-day
  // night for such an extension, and stays editableFrom for every mid-stay edit.
  const capacityRangeStart = capacityGuestRanges.reduce(
    (earliest, range) => (range.stayStart < earliest ? range.stayStart : earliest),
    editableFrom
  );

  return {
    proposedExistingGuests,
    proposedAddedGuests,
    remainingGuests,
    removedGuests,
    newTotalPriceCents,
    newDiscountCents,
    newPromoAdjustmentCents,
    newFinalPriceCents,
    priceDiffCents,
    futureExistingDeltaCents,
    futureActiveGuestCount,
    capacityGuestRanges,
    capacityRangeStart,
  };
}
