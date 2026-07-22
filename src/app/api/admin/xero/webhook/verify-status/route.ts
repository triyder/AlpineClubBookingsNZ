import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { checkXeroWebhookFreshVerify } from "@/lib/xero-webhook-validation";
import { getXeroWebhooksVerifiable } from "@/lib/xero-config";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/webhook/verify-status
 *
 * The webhook intent-to-receive verify poll + amber-badge state source (#2081).
 * Any admin may READ this (area admins keep status visibility, epic decision 4);
 * writing the webhook key is Full-Admin-only via the C1 credentials API.
 *
 * Query param `since` (ms since epoch, server-issued from an earlier call's
 * `serverNow`) scopes freshness: `freshVerified` is true only when a valid ITR
 * marker matching the CURRENT webhook key was recorded strictly after `since`.
 * The client captures `serverNow` on its first (since-less) call, then polls
 * with it — so verify-start is anchored to the server clock, never the browser's.
 *
 * Exposure contract (#2079): the response carries only booleans + timestamps —
 * never the webhook key or its fingerprint.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const sinceRaw = new URL(request.url).searchParams.get("since");
  let sinceMs: number | null = null;
  if (sinceRaw !== null) {
    const parsed = Number(sinceRaw);
    // Require a strictly positive `since`. `?since=0` (or any non-finite/negative
    // value) is unusable as a real server-issued verify-start — freshness needs a
    // marker STRICTLY newer than it, and 0 would make every marker look fresh — so
    // treat it as "no start yet" (null) and never as a satisfiable window.
    sinceMs = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  try {
    const result = await checkXeroWebhookFreshVerify(sinceMs);
    // `webhooksVerifiable` (deployment can receive Xero's ping at all) lets the
    // amber badge soften to an informational note off a public-HTTPS deployment
    // instead of nagging to finish an unfinishable step. Same derivation the
    // setup page uses, so both surfaces agree.
    return NextResponse.json({
      ...result,
      webhooksVerifiable: getXeroWebhooksVerifiable(),
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to check Xero webhook verify status");
    return NextResponse.json(
      { error: "Failed to check webhook verify status" },
      { status: 500 }
    );
  }
}
