export const BOOKING_DELETED_VISIBILITY_VALUES = [
  "hide",
  "include",
  "only",
] as const;

export type BookingDeletedVisibility =
  (typeof BOOKING_DELETED_VISIBILITY_VALUES)[number];

export function parseBookingDeletedVisibility(
  value: string | null | undefined
): BookingDeletedVisibility {
  return BOOKING_DELETED_VISIBILITY_VALUES.includes(
    value as BookingDeletedVisibility
  )
    ? (value as BookingDeletedVisibility)
    : "hide";
}

export function buildBookingDeletedWhere(
  visibility: BookingDeletedVisibility
): { deletedAt?: null | { not: null } } {
  if (visibility === "include") {
    return {};
  }

  return {
    deletedAt: visibility === "only" ? { not: null } : null,
  };
}
