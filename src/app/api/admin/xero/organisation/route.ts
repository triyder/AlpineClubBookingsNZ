import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroFinancialYearEndMonth } from "@/lib/xero-organisation";

/**
 * GET /api/admin/xero/organisation
 * Returns the connected Xero organisation's accounting financial year-end
 * month (1-12), or null if Xero is not connected. Cached in-process.
 * Pass ?refresh=1 to bypass the cache.
 */
export async function GET(request?: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const forceRefresh = request?.nextUrl.searchParams.get("refresh") === "1";
  const financialYearEndMonth = await getXeroFinancialYearEndMonth(forceRefresh);

  return NextResponse.json({ financialYearEndMonth });
}
