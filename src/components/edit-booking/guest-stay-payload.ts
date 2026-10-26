import type { Guest, NewGuest } from "@/components/edit-booking/types";
import { eachNightKey, shiftDateKey } from "@/components/edit-booking/stay-nights";

/** One guest's stay as the booking editor sends it: dates, or a night set. */
export type GuestStayFields = { stayStart?: string; stayEnd?: string; nights?: string[] };

/**
 * Every guest's stay as one booking edit sends it (#4199).
 *
 * THE one reading of the editor's date controls, shared by the modification
 * payload (which the quote and the save receive) and the promo card's preview,
 * so the promo box prices the same nights the quote and the save price
 * (`INV-SSOT-001`). The card used to rebuild this from the per-guest date
 * switch alone: in grid mode (#713) it sent a guest's Date In and Date Out
 * instead of their nights — or nothing at all — so a guest holding the 10th
 * and 12th was previewed over three nights while the quote charged two.
 */
export type EditGuestStays = {
  /** The booking dates the edit sends: the envelope around every stay. */
  checkIn: string;
  checkOut: string;
  /** Each remaining guest's entry, in party order; null when the edit sends none. */
  existing: Array<{ guestId: string } & GuestStayFields> | null;
  /** Each added guest's stay, parallel to the added guests. */
  added: GuestStayFields[];
};

/**
 * Grid mode (`multiDateRangesEnabled`) sends each guest's night set; range mode
 * (per-guest dates, grid off) sends each guest's continuous dates, which a save
 * charges as shown (#4189, owner decision); neither sends no stays, and an
 * in-progress edit never does.
 */
export function buildEditGuestStays(args: {
  multiDateRangesEnabled: boolean;
  perGuestDatesEnabled: boolean;
  isInProgressEdit: boolean;
  booking: { checkIn: string; checkOut: string };
  checkIn: string;
  checkOut: string;
  remainingGuests: ReadonlyArray<Guest>;
  addedGuests: ReadonlyArray<NewGuest>;
  existingGuestNights: Readonly<Record<string, string[]>>;
  getExistingGuestRange: (guest: Guest) => { stayStart: string; stayEnd: string };
}): EditGuestStays {
  const { booking, checkIn, checkOut } = args;
  const gridMode = args.multiDateRangesEnabled && !args.isInProgressEdit;
  const rangeMode = args.perGuestDatesEnabled && !args.isInProgressEdit && !gridMode;

  if (gridMode) {
    // Multi date range mode (issue #713): send each guest's explicit night
    // set; the server reprices, re-allocates and recomputes the envelope.
    const existing = args.remainingGuests.map((guest) => ({
      guestId: guest.id,
      nights:
        args.existingGuestNights[guest.id] ??
        eachNightKey(guest.stayStart ?? booking.checkIn, guest.stayEnd ?? booking.checkOut),
    }));
    const added = args.addedGuests.map((guest) => ({
      nights: guest.nights ?? eachNightKey(checkIn, checkOut),
    }));
    const allNights = [
      ...existing.flatMap((entry) => entry.nights),
      ...added.flatMap((entry) => entry.nights),
    ].filter(Boolean);
    if (allNights.length === 0) return { checkIn, checkOut, existing, added };
    // `.reduce()` with no seed starts from the array's own first element, so the
    // non-empty check above is the only place that fact needs to be true.
    const firstNight = allNights.reduce((a, b) => (b < a ? b : a));
    const lastNight = allNights.reduce((a, b) => (b > a ? b : a));
    return { checkIn: firstNight, checkOut: shiftDateKey(lastNight, 1), existing, added };
  }

  if (rangeMode) {
    const existing = args.remainingGuests.map((guest) => ({
      guestId: guest.id,
      ...args.getExistingGuestRange(guest),
    }));
    const added = args.addedGuests.map((guest) => ({
      stayStart: guest.stayStart ?? checkIn,
      stayEnd: guest.stayEnd ?? checkOut,
    }));
    const ranges = [...existing, ...added].filter((range) => range.stayStart && range.stayEnd);
    if (ranges.length === 0) return { checkIn, checkOut, existing, added };
    // Each bound reduced over its own values (non-empty, so no seed is needed).
    return {
      checkIn: ranges
        .map((range) => range.stayStart)
        .reduce((earliest, stayStart) => (stayStart < earliest ? stayStart : earliest)),
      checkOut: ranges
        .map((range) => range.stayEnd)
        .reduce((latest, stayEnd) => (stayEnd > latest ? stayEnd : latest)),
      existing,
      added,
    };
  }

  return { checkIn, checkOut, existing: null, added: args.addedGuests.map(() => ({})) };
}
