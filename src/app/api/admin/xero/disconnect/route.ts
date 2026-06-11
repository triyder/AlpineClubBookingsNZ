import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { disconnectXero } from "@/lib/xero";

/**
 * POST /api/admin/xero/disconnect
 * Disconnects the Xero integration by revoking and removing tokens.
 */
export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    await disconnectXero();
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to disconnect Xero";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
