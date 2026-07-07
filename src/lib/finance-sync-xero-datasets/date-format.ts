import { APP_TIME_ZONE } from "@/config/operational";
import { parseDateOnly } from "@/lib/date-only";

const FINANCE_SYNC_DATA_TIMEZONE = APP_TIME_ZONE;

function getDateOnlyStringForTimeZone(
  date: Date,
  timeZone = FINANCE_SYNC_DATA_TIMEZONE
): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to derive finance date for timezone ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}

export function parseRequiredDateOnly(value: string, fieldName: string): Date {
  const parsed = parseDateOnly(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be a valid date-only string`);
  }

  return parsed;
}

export function parseOptionalDateOnly(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = parseDateOnly(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function getFinanceReportWindow(startedAt: Date) {
  const asOfDateString = getDateOnlyStringForTimeZone(startedAt);
  const periodStartString = `${asOfDateString.slice(0, 7)}-01`;

  return {
    asOfDate: parseRequiredDateOnly(asOfDateString, "asOfDate"),
    asOfDateString,
    periodStart: parseRequiredDateOnly(periodStartString, "periodStart"),
    periodStartString,
  };
}

/** Month key ("YYYY-MM") for a timestamp, in the finance data timezone. */
export function getFinanceMonthKeyForDate(date: Date): string {
  return getDateOnlyStringForTimeZone(date).slice(0, 7);
}

export function monthStartString(monthKey: string): string {
  return `${monthKey}-01`;
}

export function monthEndString(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return `${monthKey}-${String(lastDay).padStart(2, "0")}`;
}

export function toOptionalDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function toDateOnlyString(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export function toOptionalText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const text = String(value).trim();
  return text ? text : null;
}

export function toOptionalDateOnlyText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : toDateOnlyString(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  return toOptionalText(value);
}
