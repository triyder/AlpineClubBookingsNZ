import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { getGoogleSetupState } from "@/lib/google-config";
import logger from "@/lib/logger";

// GET /api/admin/integrations/google/status — metadata-only Google setup state.
//
// Any admin may read status so area admins keep visibility (epic decision 4);
// only Full Admins can WRITE credentials (the C1 credentials API). This route
// NEVER returns any credential value — only booleans (which keys are set, the
// re-entry flag, and the verified flag). Exposure contract (#2079).
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  try {
    const state = await getGoogleSetupState();
    return NextResponse.json({
      clientIdSet: state.clientIdSet,
      clientSecretSet: state.clientSecretSet,
      needsReentry: state.needsReentry,
      verified: state.verified,
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.name : "unknown" },
      "Failed to resolve Google setup state",
    );
    return NextResponse.json(
      { error: "Could not resolve Google status." },
      { status: 500 },
    );
  }
}
