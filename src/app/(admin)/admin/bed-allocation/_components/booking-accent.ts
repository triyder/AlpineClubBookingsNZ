export interface BookingAccent {
  name: string;
  stripClassName: string;
  ringClassName: string;
  tintClassName: string;
}

export const BOOKING_ACCENTS: BookingAccent[] = [
  {
    name: "red",
    stripClassName: "bg-red-500",
    ringClassName: "ring-red-200 dark:ring-red-800/60",
    tintClassName: "bg-red-50/45 dark:bg-red-950/20",
  },
  {
    name: "orange",
    stripClassName: "bg-orange-500",
    ringClassName: "ring-orange-200 dark:ring-orange-800/60",
    tintClassName: "bg-orange-50/45 dark:bg-orange-950/20",
  },
  {
    name: "amber",
    stripClassName: "bg-amber-500",
    ringClassName: "ring-amber-200 dark:ring-amber-800/60",
    tintClassName: "bg-amber-50/45 dark:bg-amber-950/20",
  },
  {
    name: "lime",
    stripClassName: "bg-lime-500",
    ringClassName: "ring-lime-200 dark:ring-lime-800/60",
    tintClassName: "bg-lime-50/45 dark:bg-lime-950/20",
  },
  {
    name: "emerald",
    stripClassName: "bg-emerald-500",
    ringClassName: "ring-emerald-200 dark:ring-emerald-800/60",
    tintClassName: "bg-emerald-50/45 dark:bg-emerald-950/20",
  },
  {
    name: "cyan",
    stripClassName: "bg-cyan-500",
    ringClassName: "ring-cyan-200 dark:ring-cyan-800/60",
    tintClassName: "bg-cyan-50/45 dark:bg-cyan-950/20",
  },
  {
    name: "blue",
    stripClassName: "bg-blue-500",
    ringClassName: "ring-blue-200 dark:ring-blue-800/60",
    tintClassName: "bg-blue-50/45 dark:bg-blue-950/20",
  },
  {
    name: "violet",
    stripClassName: "bg-violet-500",
    ringClassName: "ring-violet-200 dark:ring-violet-800/60",
    tintClassName: "bg-violet-50/45 dark:bg-violet-950/20",
  },
  {
    name: "fuchsia",
    stripClassName: "bg-fuchsia-500",
    ringClassName: "ring-fuchsia-200 dark:ring-fuchsia-800/60",
    tintClassName: "bg-fuchsia-50/45 dark:bg-fuchsia-950/20",
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
