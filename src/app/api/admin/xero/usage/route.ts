import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getTodaysXeroUsageSummary } from "@/lib/xero-api-usage";
import logger from "@/lib/logger";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const summary = await getTodaysXeroUsageSummary();
    return NextResponse.json(summary);
  } catch (error) {
    logger.error({ err: error }, "Failed to load Xero API usage");
    return NextResponse.json({ error: "Failed to load Xero API usage" }, { status: 500 });
  }
}
