import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getTodaysXeroUsageSummary } from "@/lib/xero-api-usage";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const summary = await getTodaysXeroUsageSummary();
    return NextResponse.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load Xero API usage";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
