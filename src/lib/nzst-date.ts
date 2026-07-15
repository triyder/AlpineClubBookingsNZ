import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";

const NZ_TIME_ZONE = APP_TIME_ZONE;

const NZ_DATE_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: NZ_TIME_ZONE,
  dateStyle: "medium",
});

const NZ_DATE_TIME_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: NZ_TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatNZDate(date: Date): string {
  return NZ_DATE_FORMATTER.format(date);
}

export function formatNZDateTime(date: Date): string {
  return NZ_DATE_TIME_FORMATTER.format(date);
}

// The NZST "today"/"tomorrow" helpers were removed (issue #1878): they built
// `new Date(`${y}-${m}-${d}T00:00:00`)` — no timezone suffix, so the string
// parsed in the server's LOCAL zone and, under the production
// TZ=Pacific/Auckland pin, serialized as the previous UTC day in every Prisma
// @db.Date comparison. Cron jobs that need the NZ calendar date must use
// getTodayDateOnly()/addDaysDateOnly() from "@/lib/date-only", which pin the
// NZ calendar date to UTC midnight.
