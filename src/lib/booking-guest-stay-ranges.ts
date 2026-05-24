import { formatDateOnlyForTimeZone } from "@/lib/date-only";

export type GuestStayRange = {
  stayStart?: Date | null;
  stayEnd?: Date | null;
};

export type BookingStayRange = {
  checkIn: Date;
  checkOut: Date;
};

function dateOnlyKey(value: Date): string {
  return formatDateOnlyForTimeZone(value);
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
