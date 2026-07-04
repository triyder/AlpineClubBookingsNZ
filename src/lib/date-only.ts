import { APP_TIME_ZONE } from "@/config/operational";

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function buildDateOnly(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

export function isDateOnlyString(dateStr: string): boolean {
  if (!DATE_ONLY_REGEX.test(dateStr)) {
    return false;
  }

  const parsed = buildDateOnly(dateStr);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateStr;
}

export function parseDateOnly(dateStr: string): Date {
  return isDateOnlyString(dateStr) ? buildDateOnly(dateStr) : new Date(NaN);
}

function getDateParts(dateStr: string) {
  if (!isDateOnlyString(dateStr)) {
    return null;
  }

  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month, day };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const readPart = (type: string) => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : NaN;
  };
  const asUtc = Date.UTC(
    readPart("year"),
    readPart("month") - 1,
    readPart("day"),
    readPart("hour"),
    readPart("minute"),
    readPart("second")
  );

  return asUtc - date.getTime();
}

function zonedDateOnlyTimeToUtc(
  dateStr: string,
  timeZone: string,
  hours = 0,
  minutes = 0,
  seconds = 0,
  milliseconds = 0
): Date {
  const parts = getDateParts(dateStr);
  if (!parts) return new Date(NaN);

  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hours,
    minutes,
    seconds,
    milliseconds
  );
  let result = new Date(localAsUtc - getTimeZoneOffsetMs(new Date(localAsUtc), timeZone));
  result = new Date(localAsUtc - getTimeZoneOffsetMs(result, timeZone));
  return result;
}

export function startOfDateOnlyForTimeZone(
  dateStr: string,
  timeZone = APP_TIME_ZONE
): Date {
  return zonedDateOnlyTimeToUtc(dateStr, timeZone);
}

export function endOfDateOnlyForTimeZone(
  dateStr: string,
  timeZone = APP_TIME_ZONE
): Date {
  const nextDate = addDaysDateOnly(parseDateOnly(dateStr), 1);
  if (Number.isNaN(nextDate.getTime())) return new Date(NaN);
  const nextStart = startOfDateOnlyForTimeZone(formatDateOnly(nextDate), timeZone);
  return new Date(nextStart.getTime() - 1);
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatLocalDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Intl.DateTimeFormat construction costs ~0.1ms; the capacity, pricing, and
// finance loops call this once per (booking, night) pair, so a fresh formatter
// per call dominated those paths. Instances are stateless for formatToParts,
// so one per time zone is shared safely.
const dateOnlyFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDateOnlyFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateOnlyFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateOnlyFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function formatDateOnlyForTimeZone(
  date: Date,
  timeZone = APP_TIME_ZONE
): string {
  const parts = getDateOnlyFormatter(timeZone).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to derive date-only value for timezone ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}

export function normalizeDateOnlyForTimeZone(
  date: Date,
  timeZone = APP_TIME_ZONE
): Date {
  const normalized = parseDateOnly(formatDateOnlyForTimeZone(date, timeZone));

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(`Invalid date-only value: ${date.toISOString()}`);
  }

  return normalized;
}

export function addDaysDateOnly(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function eachDateOnlyInRange(startInclusive: Date, endExclusive: Date): Date[] {
  const dates: Date[] = [];

  for (
    let current = new Date(startInclusive);
    current < endExclusive;
    current = addDaysDateOnly(current, 1)
  ) {
    dates.push(current);
  }

  return dates;
}

export function getTodayDateOnly(timeZone = APP_TIME_ZONE): Date {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to derive current date for timezone ${timeZone}`);
  }

  const today = parseDateOnly(`${year}-${month}-${day}`);
  if (Number.isNaN(today.getTime())) {
    throw new Error(`Unable to derive current date for timezone ${timeZone}`);
  }

  return today;
}
