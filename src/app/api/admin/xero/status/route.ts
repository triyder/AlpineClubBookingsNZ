import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroConnectionStatus } from "@/lib/xero";
import { getXeroFeatureFlags } from "@/lib/xero-feature-flags";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/status
 * Returns the current Xero connection status.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const status = await getXeroConnectionStatus();
    return NextResponse.json({
      ...status,
      features: getXeroFeatureFlags(),
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to check Xero status");
    return NextResponse.json({ error: "Failed to check Xero status" }, { status: 500 });
  }
}
