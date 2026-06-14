import { formatDateOnlyForTimeZone, isDateOnlyString } from "@/lib/date-only";

/**
 * A single included night for a guest. Accepts a Date, a `yyyy-mm-dd`
 * date-only string, or the Prisma `BookingGuestNight` relation row shape so a
 * guest loaded with `include: { nights: true }` can be passed straight through.
 */
export type GuestNightInput = Date | string | { stayDate: Date | string };

export type GuestStayRange = {
  stayStart?: Date | null;
  stayEnd?: Date | null;
  // Explicit set of included nights (issue #713). When present and non-empty,
  // this is the authoritative per-night presence for the guest and overrides
  // the contiguous stayStart/stayEnd envelope. When absent/empty, presence
  // falls back to the envelope — which keeps every read surface that loads only
  // stayStart/stayEnd behaving exactly as before.
  nights?: ReadonlyArray<GuestNightInput> | null;
};

export type BookingStayRange = {
  checkIn: Date;
  checkOut: Date;
};

function dateOnlyKey(value: Date): string {
  return formatDateOnlyForTimeZone(value);
}

/**
 * Derive the date-only key for one explicit night entry, matching the key
 * scheme used everywhere else (NZ time zone via formatDateOnlyForTimeZone).
 */
function nightEntryKey(entry: GuestNightInput): string {
  if (typeof entry === "string") {
    return isDateOnlyString(entry) ? entry : dateOnlyKey(new Date(entry));
  }
  if (entry instanceof Date) {
    return dateOnlyKey(entry);
  }
  return nightEntryKey(entry.stayDate);
}

// Cache the derived key set per `nights` array reference. The capacity and
// pricing loops call isGuestActiveOnNight once per (guest, night), so without
// this each call would rebuild the set; the WeakMap keeps it O(nights) once.
const nightKeySetCache = new WeakMap<object, Set<string>>();

/**
 * The set of date-only keys a guest explicitly stays, or null when the guest
 * has no explicit night set (caller should fall back to the envelope).
 */
export function getGuestNightKeySet(
  guest: GuestStayRange
): Set<string> | null {
  const nights = guest.nights;
  if (!nights || nights.length === 0) {
    return null;
  }
  const cached = nightKeySetCache.get(nights as unknown as object);
  if (cached) {
    return cached;
  }
  const set = new Set<string>();
  for (const entry of nights) {
    set.add(nightEntryKey(entry));
  }
  nightKeySetCache.set(nights as unknown as object, set);
  return set;
}

export function getGuestStayStart(
  guest: GuestStayRange,
  booking: BookingStayRange
): Date {
  return guest.stayStart ?? booking.checkIn;
}

export function getGuestStayEnd(
  guest: GuestStayRange,
  booking: BookingStayRange
): Date {
  return guest.stayEnd ?? booking.checkOut;
}

export function isGuestActiveOnNight(
  guest: GuestStayRange,
  night: Date,
  booking: BookingStayRange
): boolean {
  const nightKey = dateOnlyKey(night);

  // Explicit night set wins: a guest is active on a night iff that night is in
  // their set. This correctly handles non-contiguous stays (gaps are absences).
  const nightKeySet = getGuestNightKeySet(guest);
  if (nightKeySet) {
    return nightKeySet.has(nightKey);
  }

  // Fallback: contiguous envelope, half-open [stayStart, stayEnd).
  const stayStartKey = dateOnlyKey(getGuestStayStart(guest, booking));
  const stayEndKey = dateOnlyKey(getGuestStayEnd(guest, booking));

  return stayStartKey <= nightKey && nightKey < stayEndKey;
}

export function isGuestVisibleOnLodgeDate(
  guest: GuestStayRange,
  date: Date,
  booking: BookingStayRange,
  options?: { includeDepartureDate?: boolean }
): boolean {
  const dateKey = dateOnlyKey(date);

  // For explicit night sets, "visible on a lodge date" means the guest stays
  // that night, plus the morning after their last included night when
  // includeDepartureDate is set (the checkout-day visibility the board uses).
  const nightKeySet = getGuestNightKeySet(guest);
  if (nightKeySet) {
    if (nightKeySet.has(dateKey)) {
      return true;
    }
    if (options?.includeDepartureDate) {
      let maxKey: string | null = null;
      for (const key of nightKeySet) {
        if (maxKey === null || key > maxKey) maxKey = key;
      }
      if (maxKey !== null) {
        const departureKey = formatDateOnlyForTimeZone(
          new Date(new Date(`${maxKey}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000)
        );
        return dateKey === departureKey;
      }
    }
    return false;
  }

  const stayStartKey = dateOnlyKey(getGuestStayStart(guest, booking));
  const stayEndKey = dateOnlyKey(getGuestStayEnd(guest, booking));

  return options?.includeDepartureDate
    ? stayStartKey <= dateKey && dateKey <= stayEndKey
    : stayStartKey <= dateKey && dateKey < stayEndKey;
}

export function getActiveGuestsForNight<Guest extends GuestStayRange>(
  guests: Guest[] | null | undefined,
  night: Date,
  booking: BookingStayRange
): Guest[] {
  return (guests ?? []).filter((guest) =>
    isGuestActiveOnNight(guest, night, booking)
  );
}

export function countActiveGuestsForNight(
  guests: GuestStayRange[] | null | undefined,
  night: Date,
  booking: BookingStayRange
): number {
  return getActiveGuestsForNight(guests, night, booking).length;
}

export function getLodgeVisibleGuestsForDate<Guest extends GuestStayRange>(
  guests: Guest[] | null | undefined,
  date: Date,
  booking: BookingStayRange,
  options?: { includeDepartureDate?: boolean }
): Guest[] {
  return (guests ?? []).filter((guest) =>
    isGuestVisibleOnLodgeDate(guest, date, booking, options)
  );
}
