import { BookingRequestType, type Prisma } from "@prisma/client";

/**
 * IS THIS BOOKING A SCHOOL GROUP'S? — the one answer (`INV-SSOT-001`).
 *
 * A booking converted from, or held for, a SCHOOL booking request. Bed
 * allocation rooms such a group's adults together and its students separately
 * (#1768), and hut-leader coverage lets each lodge decide who may lead its
 * nights (#3819). Both ask here: {@link isSchoolGroupBooking} for a loaded row,
 * {@link SCHOOL_GROUP_BOOKING_WHERE} for a query.
 */
type RequestLink = { type: BookingRequestType | `${BookingRequestType}` } | null | undefined;

export function isSchoolGroupBooking(booking: {
  originBookingRequest?: RequestLink;
  heldForBookingRequest?: RequestLink;
} | null | undefined): boolean {
  return (
    booking?.originBookingRequest?.type === BookingRequestType.SCHOOL ||
    booking?.heldForBookingRequest?.type === BookingRequestType.SCHOOL
  );
}

/**
 * The ACCEPTED half of {@link SCHOOL_GROUP_BOOKING_WHERE}: a booking converted
 * from a school request, never one only held for a quote the school has not
 * accepted. Hut-leader duty reads this half (owner decision on #3820, 13 Oct
 * 2026: "a school booking that holds beds (CONFIRMED, awaiting its invoice)").
 */
export const SCHOOL_GROUP_CONVERTED_BOOKING_WHERE = {
  originBookingRequest: { is: { type: BookingRequestType.SCHOOL } },
} as const satisfies Prisma.BookingWhereInput;

/**
 * {@link isSchoolGroupBooking} as a Prisma filter. Its top level is an `OR`, so
 * spread it under `AND` beside a where that has an `OR` of its own.
 */
export const SCHOOL_GROUP_BOOKING_WHERE = {
  OR: [
    SCHOOL_GROUP_CONVERTED_BOOKING_WHERE,
    { heldForBookingRequest: { is: { type: BookingRequestType.SCHOOL } } },
  ],
} as const satisfies Prisma.BookingWhereInput;
