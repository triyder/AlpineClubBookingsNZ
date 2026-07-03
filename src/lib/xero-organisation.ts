/**
 * Reads the connected Xero organisation's accounting financial year-end month.
 *
 * Used as the default for the membership financial year (an admin can override
 * it when the membership subscription year differs from the accounting year).
 * The value changes almost never, so it is cached in-process with a long TTL.
 * Each serverless instance fetches at most once per TTL.
 */

import logger from "@/lib/logger";
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
