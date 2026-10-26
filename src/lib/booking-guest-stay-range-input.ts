import {
  addDaysDateOnly,
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import { MAX_CONFIGURED_LODGE_CAPACITY } from "@/lib/lodge-effective-capacity";
import { z } from "zod";

/** What a member is told about a night that is not a real day (#4088). */
export const GUEST_NIGHT_INVALID_MESSAGE =
  "One of the nights chosen isn't a valid date. Please choose the nights again.";

/**
 * A guest's explicit night set (#713) as a request carries it: `yyyy-mm-dd`
 * nights, at most a year of them. The one request shape for `nights`, shared by
 * the booking-policy exception doors and the locked-period change request
 * (#4088), and by create, quote and the promo preview (#4199), because zod
 * STRIPS a key a schema does not declare: a door that
 * forgot `nights` silently turned a guest's chosen nights into the whole stay
 * (#2562 review, #4088). What the nights MEAN is still decided only by
 * `normalizeGuestStayRange` below.
 */
export const guestNightListSchema = z
  .array(z.string().refine(isDateOnlyString, { message: GUEST_NIGHT_INVALID_MESSAGE }))
  .max(370);

/**
 * One guest's stay as a request carries it (#4199): Date In and Date Out, or the
 * grid's night set, which wins. THE one declaration, spread into every door
 * that names guests (`...guestStayFieldsSchema.shape`), so no door can declare
 * the bounds and forget `nights` — the silent "whole stay" this file's
 * `guestNightListSchema` exists to stop. What the fields MEAN is decided only
 * by `normalizeGuestStayRange`.
 */
export const guestStayFieldsSchema = z.object({
  stayStart: z.string().optional(),
  stayEnd: z.string().optional(),
  nights: guestNightListSchema.optional(),
});

/**
 * The bound on a list of CHANGES (#4199): the guests one request adds, removes
 * or renames (`addGuests`, `removeGuestIds`, `guestUpdates`, the officer's and
 * the change request's added guests, the add-guests route), and a new
 * booking's party (create and the new-booking exception door), which has always
 * been 200. Far above any real change, so a hostile payload cannot turn a
 * per-guest loop into an unbounded one. Never put it on a list that carries a
 * live booking's WHOLE party: see `BOOKING_PARTY_GUESTS_MAX`.
 */
export const BOOKING_REQUEST_GUESTS_MAX = 200;

/** What a member is told when a list of changes passes that bound (#4199). */
export const GUEST_CHANGE_LIST_TOO_LONG_MESSAGE = `A request can add or change at most ${BOOKING_REQUEST_GUESTS_MAX} guests. Please make the change in smaller steps.`;

/** That bound with its wording, for `.max(...GUEST_CHANGE_LIST_BOUND)` on a list of changes. */
export const GUEST_CHANGE_LIST_BOUND = [BOOKING_REQUEST_GUESTS_MAX, GUEST_CHANGE_LIST_TOO_LONG_MESSAGE] as const;

/**
 * The bound on a list that carries a live booking's WHOLE party (#4199): every
 * guest's stay on a grid or range-mode edit (`guestStayRanges` on modify, the
 * modify quote, the exception and change-request doors), the promo preview's
 * and the quote's `guests`, and the guest ids and indexes chosen from that
 * party. A booking can outgrow 200 guests through add-guest calls at a lodge
 * that holds more, so these are bounded by the most a lodge can be configured
 * to hold — never below what a booking can legitimately carry.
 */
export const BOOKING_PARTY_GUESTS_MAX = MAX_CONFIGURED_LODGE_CAPACITY;

/** The member-worded refusals every door that names guests can give (#4199). */
export const GUEST_REQUEST_MEMBER_WORDED_MESSAGES: readonly string[] = [
  GUEST_NIGHT_INVALID_MESSAGE,
  GUEST_CHANGE_LIST_TOO_LONG_MESSAGE,
];

/**
 * The `error` a door answers when its request schema refuses (#4088, #4199): a
 * refusal written for the member — a night that is not a real day, or a list of
 * changes that is too long, by default — is said in their terms; anything else
 * keeps the door's own `fallback`, with the details beside it. Matched on the
 * exact message, so no other failure is reported as one of these.
 */
export function guestRequestSchemaError(
  error: z.ZodError,
  fallback: string,
  memberWorded: readonly string[] = GUEST_REQUEST_MEMBER_WORDED_MESSAGES,
): string {
  const worded = memberWorded.find((message) => error.issues.some((issue) => issue.message === message));
  return worded ?? fallback;
}

export type BookingGuestStayRangeInput = {
  stayStart?: Date | string | null;
  stayEnd?: Date | string | null;
  // Explicit set of included nights (issue #713 — multi date range stays).
  // When present and non-empty, the guest stays exactly these nights (which may
  // be non-contiguous); stayStart/stayEnd are derived as the min/max envelope.
  nights?: ReadonlyArray<Date | string> | null;
};

export type NormalizedBookingGuestStayRange = {
  stayStart: Date;
  stayEnd: Date;
  // Present only when the guest was given an explicit night set; the booking
  // range is then auto-expanded by the caller to cover these nights.
  nights?: Date[];
};

export class BookingGuestStayRangeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingGuestStayRangeValidationError";
  }
}

function hasDateValue(value: Date | string | null | undefined): boolean {
  return value instanceof Date || (typeof value === "string" && value.trim() !== "");
}

function normalizeInputDate(value: Date | string, fieldName: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new BookingGuestStayRangeValidationError(`${fieldName} must be a valid date.`);
    }

    // A caller handing in a `Date` is handing in a stored calendar day, so read
    // it as one. The only live producer of this branch is a stored delta replay;
    // every member-supplied field on the input types is a string and takes the
    // `parseDateOnly` branch below.
    return storedDateOnly(value);
  }

  const trimmed = value.trim();
  if (!isDateOnlyString(trimmed)) {
    throw new BookingGuestStayRangeValidationError(`${fieldName} must use yyyy-mm-dd format.`);
  }

  const parsed = parseDateOnly(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new BookingGuestStayRangeValidationError(`${fieldName} must be a valid date.`);
  }

  return parsed;
}

/**
 * Normalize a guest's stay into a contiguous range or an explicit night set.
 *
 * Issue #713 replaced the old hard rejection of dates outside the booking
 * checkIn/checkOut with auto-expansion: this function no longer rejects
 * out-of-range dates. Instead it normalizes the guest's stay and the caller
 * expands the booking range to cover it (validating capacity + season-rate
 * coverage inside the advisory lock). The `booking` argument is still used to
 * default a guest with no dates to the whole booking range.
 */
export function normalizeGuestStayRange(
  guest: BookingGuestStayRangeInput,
  booking: { checkIn: Date; checkOut: Date },
  index: number
): NormalizedBookingGuestStayRange {
  // CT-4 (#2870), group F4b: THE STORED CALENDAR DAYS, read as themselves.
  //
  // These two lines were `normalizeDateOnlyForTimeZone`, which projected the
  // envelope through `APP_TIME_ZONE` — the identity for a club ahead of
  // Greenwich, the PREVIOUS DAY for one behind it. They default a guest who
  // supplied no dates of their own, which is what the member form sends for
  // every guest unless multi-range mode is open, so on a Denver club that guest
  // was priced, capacity-checked, frozen for an officer and executed a night
  // early. `checkIn`/`checkOut` are `@db.Date` lodge-night identities and take
  // no zone at all (`INV-DATE-019`, `INV-DATE-026`).
  //
  // BOTH callers of this default were affected, and the ledger recorded only
  // one. `resolveModificationStayRanges` normalises every ADDED guest here
  // against the final envelope, including a range-less one — while its own first
  // pass defaults that same guest to the unprojected envelope. So one call
  // computed the envelope in one frame and the guest's range in another, leaving
  // the guest a night outside the booking they were added to. Pinned on both the
  // environment and the host axis in
  // `__tests__/booking-range-less-guest-frame.test.ts`.
  const checkIn = storedDateOnly(booking.checkIn);
  const checkOut = storedDateOnly(booking.checkOut);
  const label = `Guest ${index + 1}`;

  // Explicit night set (multi date range mode): normalize, dedupe and sort.
  if (guest.nights && guest.nights.length > 0) {
    const byKey = new Map<string, Date>();
    guest.nights.forEach((night, nightIndex) => {
      const normalized = normalizeInputDate(
        night,
        `${label} night ${nightIndex + 1}`
      );
      byKey.set(formatDateOnly(normalized), normalized);
    });
    // Both ends of the selected nights; reading them is what says at least one
    // was selected, and the envelope stays half-open over exactly those nights
    // (#2800, INV-DATE).
    const sorted = [...byKey.values()].sort((a, b) => a.getTime() - b.getTime());
    const firstNight = sorted[0];
    const lastNight = sorted.at(-1);
    if (firstNight === undefined || lastNight === undefined) {
      throw new BookingGuestStayRangeValidationError(
        `${label}: select at least one night.`
      );
    }
    return {
      stayStart: firstNight,
      stayEnd: addDaysDateOnly(lastNight, 1),
      nights: sorted,
    };
  }

  const hasStayStart = hasDateValue(guest.stayStart);
  const hasStayEnd = hasDateValue(guest.stayEnd);

  if (!hasStayStart && !hasStayEnd) {
    return { stayStart: checkIn, stayEnd: checkOut };
  }

  if (!hasStayStart || !hasStayEnd) {
    throw new BookingGuestStayRangeValidationError(
      `${label}: Date In and Date Out are both required.`
    );
  }

  const stayStart = normalizeInputDate(guest.stayStart as Date | string, `${label} Date In`);
  const stayEnd = normalizeInputDate(guest.stayEnd as Date | string, `${label} Date Out`);

  if (stayEnd <= stayStart) {
    throw new BookingGuestStayRangeValidationError(
      `${label}: Date Out must be after Date In.`
    );
  }

  // No range rejection: a guest whose dates fall outside the booking range
  // expands the booking range (issue #713). Single-range bookings whose guest
  // dates already sit within the range are unaffected.
  return { stayStart, stayEnd };
}

export function normalizeGuestStayRanges<Guest extends BookingGuestStayRangeInput>(
  guests: Guest[],
  booking: { checkIn: Date; checkOut: Date }
): Array<Guest & NormalizedBookingGuestStayRange> {
  return guests.map((guest, index) => ({
    ...guest,
    ...normalizeGuestStayRange(guest, booking, index),
  }));
}
