/**
 * Reads the connected Xero organisation's accounting financial year-end month.
 *
 * Used as the default for the membership financial year (an admin can override
 * it when the membership subscription year differs from the accounting year).
 * The value changes almost never, so it is cached in-process with a long TTL.
 * Each serverless instance fetches at most once per TTL.
 */

import logger from "@/lib/logger";
import { parseDateOnly } from "@/lib/date-only";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";

const ORG_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

interface OrgYearEndCacheEntry {
  month: number | null;
  fetchedAt: number;
}

let cached: OrgYearEndCacheEntry | null = null;

/**
 * Returns the Xero organisation's financial year-end month (1-12), or null if
 * Xero is not connected or the value is unavailable. Cached in-process.
 */
export async function getXeroFinancialYearEndMonth(
  forceRefresh = false,
): Promise<number | null> {
  if (
    !forceRefresh &&
    cached &&
    Date.now() - cached.fetchedAt < ORG_CACHE_TTL_MS
  ) {
    return cached.month;
  }

  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getOrganisations(tenantId),
      {
        operation: "getOrganisations",
        resourceType: "ORGANISATION",
        workflow: "membershipFinancialYear",
        context: "xero-organisation getFinancialYearEndMonth",
      },
    );
    const raw = response.body.organisations?.[0]?.financialYearEndMonth;
    const month =
      typeof raw === "number" && raw >= 1 && raw <= 12 ? raw : null;
    cached = { month, fetchedAt: Date.now() };
    return month;
  } catch (error) {
    logger.warn(
      { err: error },
      "Failed to read Xero organisation financial year-end month",
    );
    // Fall back to the last cached value if we have one, otherwise null.
    return cached?.month ?? null;
  }
}

// ---------------------------------------------------------------------------
// Xero lock dates (#1695): the accounting period lock date and end-of-year
// lock date. A retroactive booking whose check-in (its Xero invoice issue date)
// falls on or before the effective lock date is rejected at create time, so the
// invoice never has to post into a locked period. Cached with a short TTL — the
// admin can unlock the period in Xero and retry within a few minutes.
// ---------------------------------------------------------------------------

const LOCK_DATES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface XeroLockDates {
  periodLockDate: Date | null;
  endOfYearLockDate: Date | null;
}

interface OrgLockDatesCacheEntry {
  lockDates: XeroLockDates;
  fetchedAt: number;
}

let lockDatesCache: OrgLockDatesCacheEntry | null = null;

/**
 * Parse a Xero lock-date value into a date-only Date, or null when unset or
 * unparseable. xero-node TYPES these fields as optional strings, but its
 * ObjectSerializer converts any string payload starting with `/Date(` into a
 * JS Date at runtime (deserializeDateFormats), so when an organisation has a
 * lock date set the value arrives here as a Date object. A raw string can
 * still appear as a Microsoft-JSON `/Date(1234567890000+1300)/` timestamp or
 * an ISO date string, so all three shapes must parse.
 */
function parseXeroLockDate(value: string | Date | undefined | null): Date | null {
  if (!value) return null;

  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) {
      // Normalize to a date-only Date in UTC, matching the MS-JSON path below.
      const parsed = parseDateOnly(value.toISOString().slice(0, 10));
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    logger.warn({ value }, "Unparseable Xero lock date; treating as unset");
    return null;
  }

  const msJson = /\/Date\((\d+)/.exec(value);
  if (msJson) {
    const epochMs = Number(msJson[1]);
    if (Number.isFinite(epochMs)) {
      // Normalize to a date-only Date in UTC (lock dates are whole days).
      const parsed = parseDateOnly(new Date(epochMs).toISOString().slice(0, 10));
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  } else {
    const parsed = parseDateOnly(value.slice(0, 10));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  // A SET but unrecognisable lock date must not silently disable the guard —
  // treat-as-unset fails open, so make the format drift loud.
  logger.warn({ value }, "Unparseable Xero lock date; treating as unset");
  return null;
}

/**
 * Returns the connected Xero organisation's period and end-of-year lock dates
 * as date-only Dates (null when unset). Cached in-process for a few minutes.
 *
 * Unlike getXeroFinancialYearEndMonth, this THROWS on a fetch failure when no
 * fresh cache is available: the retroactive-booking route fails closed rather
 * than silently skipping the lock-date guard.
 */
export async function getXeroLockDates(
  forceRefresh = false,
): Promise<XeroLockDates> {
  if (
    !forceRefresh &&
    lockDatesCache &&
    Date.now() - lockDatesCache.fetchedAt < LOCK_DATES_CACHE_TTL_MS
  ) {
    return lockDatesCache.lockDates;
  }

  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getOrganisations(tenantId),
      {
        operation: "getOrganisations",
        resourceType: "ORGANISATION",
        workflow: "retroactiveBookingLockDates",
        context: "xero-organisation getLockDates",
      },
    );
    const org = response.body.organisations?.[0];
    const lockDates: XeroLockDates = {
      periodLockDate: parseXeroLockDate(org?.periodLockDate),
      endOfYearLockDate: parseXeroLockDate(org?.endOfYearLockDate),
    };
    lockDatesCache = { lockDates, fetchedAt: Date.now() };
    return lockDates;
  } catch (error) {
    // Fail closed: a fresh cache satisfies the caller, otherwise re-throw so
    // the route returns a retryable error instead of skipping the guard.
    if (
      lockDatesCache &&
      Date.now() - lockDatesCache.fetchedAt < LOCK_DATES_CACHE_TTL_MS
    ) {
      return lockDatesCache.lockDates;
    }
    logger.warn({ err: error }, "Failed to read Xero organisation lock dates");
    throw error;
  }
}

/**
 * The effective lock date is the later of the two set dates: a booking must
 * clear whichever period is locked further into the future. Null when neither
 * is set.
 */
export function getEffectiveXeroLockDate(lockDates: XeroLockDates): Date | null {
  const { periodLockDate, endOfYearLockDate } = lockDates;
  if (periodLockDate && endOfYearLockDate) {
    return periodLockDate.getTime() >= endOfYearLockDate.getTime()
      ? periodLockDate
      : endOfYearLockDate;
  }
  return periodLockDate ?? endOfYearLockDate ?? null;
}

// test seam
export function resetXeroLockDatesCacheForTests(): void {
  lockDatesCache = null;
}
