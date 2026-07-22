import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getAiUsageSummary } from "@/lib/ai-assistant-usage";
import logger from "@/lib/logger";

// GET /api/admin/ai-assistant/usage — AI help assistant usage + spend summary
// for the admin panel (#2211, C3). Matches the Xero usage route's permission
// shape: an admin guard (resolves to support/view via the route-area header).
// The response NEVER contains question text.
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const summary = await getAiUsageSummary();
    return NextResponse.json(summary);
  } catch (error) {
    logger.error({ err: error }, "Failed to load AI assistant usage");
    return NextResponse.json(
      { error: "Failed to load AI assistant usage" },
      { status: 500 },
    );
  }
}
