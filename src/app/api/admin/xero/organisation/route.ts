import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroConnectedOrganisation } from "@/lib/xero-organisation";

/**
 * GET /api/admin/xero/organisation
 * Returns the connected Xero organisation's NAME (for the setup wizard's
 * right-org confirmation, #2080) and its accounting financial year-end month
 * (1-12), or null for each if Xero is not connected. Cached in-process. Pass
 * ?refresh=1 to bypass the cache.
 */
export async function GET(request?: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const forceRefresh = request?.nextUrl.searchParams.get("refresh") === "1";
  const { name, financialYearEndMonth } =
    await getXeroConnectedOrganisation(forceRefresh);

  return NextResponse.json({ name, financialYearEndMonth });
}
