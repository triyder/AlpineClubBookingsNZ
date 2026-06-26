/**
 * Server-side resolution of the membership financial year-end month.
 *
 * Resolves the effective month in this order:
 *   1. admin override (MembershipLockoutSettings.financialYearEndMonthOverride)
 *   2. the connected Xero organisation's accounting financial year
 *   3. March (the default)
 *
 * The resolved value is written into the synchronous cache in
 * `financial-year.ts` so the season helpers stay synchronous. This module is
 * server-only (it touches Prisma and Xero), so it must never be imported into
 * client bundles.
 */

import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  setFinancialYearEndMonth,
} from "@/lib/financial-year";
import { loadMembershipLockoutSettings } from "@/lib/membership-lockout-settings";
import { getXeroFinancialYearEndMonth } from "@/lib/xero-organisation";

/**
 * Resolve the effective year-end month, update the in-process cache, and return
 * it. Safe to call on every gated request: it reseeds the cache for this
 * instance so the synchronous helpers are correct.
 */
export async function refreshFinancialYearConfig(): Promise<number> {
  const month = await resolveFinancialYearEndMonth();
  setFinancialYearEndMonth(month);
  return month;
}

/**
 * Resolve the effective year-end month without touching the cache. Returns the
 * pieces needed by the admin UI as well.
 */
export async function resolveFinancialYearEndMonth(): Promise<number> {
  const { effectiveMonth } = await getFinancialYearResolution();
  return effectiveMonth;
}

export interface FinancialYearResolution {
  /** The override set by the admin, or null when following Xero. */
  overrideMonth: number | null;
  /** The connected Xero organisation's year-end month, or null. */
  xeroMonth: number | null;
  /** The resolved month actually in effect (1-12). */
  effectiveMonth: number;
}

export async function getFinancialYearResolution(): Promise<FinancialYearResolution> {
  const settings = await loadMembershipLockoutSettings();
  const overrideMonth = settings.financialYearEndMonthOverride;
  const xeroMonth =
    overrideMonth == null ? await getXeroFinancialYearEndMonth() : null;
  const effectiveMonth =
    overrideMonth ?? xeroMonth ?? DEFAULT_FINANCIAL_YEAR_END_MONTH;
  return { overrideMonth, xeroMonth, effectiveMonth };
}
