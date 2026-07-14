export interface BookingAccent {
  name: string;
  stripClassName: string;
  ringClassName: string;
}

export const BOOKING_ACCENTS: BookingAccent[] = [
  {
    name: "red",
    stripClassName: "bg-red-500",
    ringClassName: "ring-red-200 dark:ring-red-800/60",
  },
  {
    name: "orange",
    stripClassName: "bg-orange-500",
    ringClassName: "ring-orange-200 dark:ring-orange-800/60",
  },
  {
    name: "amber",
    stripClassName: "bg-amber-500",
    ringClassName: "ring-amber-200 dark:ring-amber-800/60",
  },
  {
    name: "lime",
    stripClassName: "bg-lime-500",
    ringClassName: "ring-lime-200 dark:ring-lime-800/60",
  },
  {
    name: "emerald",
    stripClassName: "bg-emerald-500",
    ringClassName: "ring-emerald-200 dark:ring-emerald-800/60",
  },
  {
    name: "cyan",
    stripClassName: "bg-cyan-500",
    ringClassName: "ring-cyan-200 dark:ring-cyan-800/60",
  },
  {
    name: "blue",
    stripClassName: "bg-blue-500",
    ringClassName: "ring-blue-200 dark:ring-blue-800/60",
  },
  {
    name: "violet",
    stripClassName: "bg-violet-500",
    ringClassName: "ring-violet-200 dark:ring-violet-800/60",
  },
  {
    name: "fuchsia",
    stripClassName: "bg-fuchsia-500",
    ringClassName: "ring-fuchsia-200 dark:ring-fuchsia-800/60",
  },
];

function hashBookingId(bookingId: string) {
  let hash = 0;
  for (let index = 0; index < bookingId.length; index += 1) {
    hash = (hash * 31 + bookingId.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function getBookingAccent(bookingId: string): BookingAccent {
  return BOOKING_ACCENTS[hashBookingId(bookingId) % BOOKING_ACCENTS.length];
}
