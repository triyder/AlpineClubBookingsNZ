import { NextRequest, NextResponse } from "next/server";
import { Account } from "xero-node";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero";
import {
  type XeroAccount,
  getCachedChartOfAccounts,
  setCachedChartOfAccounts,
} from "@/lib/xero-admin-cache";

/**
 * GET /api/admin/xero/chart-of-accounts
 * Fetches accounts from the Xero chart of accounts, cached for 1 hour.
 * Returns { accounts: XeroAccount[] }
 */
export async function GET(request?: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const forceRefresh = request?.nextUrl.searchParams.get("refresh") === "1";

  if (!forceRefresh) {
    const cachedAccounts = await getCachedChartOfAccounts();
    if (cachedAccounts) {
      return NextResponse.json({
        accounts: cachedAccounts.values,
        cache: cachedAccounts.metadata,
      });
    }
  }

  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getAccounts(tenantId),
      {
        operation: "getAccounts",
        resourceType: "ACCOUNT",
        workflow: "adminFetchChartOfAccounts",
        context: "admin/xero/chart-of-accounts",
      }
    );
    const raw = response.body.accounts ?? [];

    const accounts: XeroAccount[] = raw
      .filter((a) => a.code && a.name && a.type && a.status === Account.StatusEnum.ACTIVE)
      .map((a) => ({
        code: a.code!,
        name: a.name!,
        type: String(a.type),
        class: String(a._class ?? ""),
      }))
      .sort((a, b) => a.code.localeCompare(b.code));

    const cache = await setCachedChartOfAccounts(tenantId, accounts);

    return NextResponse.json({ accounts, cache });
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch chart of accounts");
    return NextResponse.json({ error: "Failed to fetch chart of accounts" }, { status: 500 });
  }
}
