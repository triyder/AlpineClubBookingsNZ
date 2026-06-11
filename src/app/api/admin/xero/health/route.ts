import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroAdminHealthSnapshot } from "@/lib/xero-admin-health";
import logger from "@/lib/logger";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const snapshot = await getXeroAdminHealthSnapshot();
    return NextResponse.json(snapshot);
  } catch (error) {
    logger.error({ err: error }, "Failed to load Xero admin health snapshot");
    return NextResponse.json(
      { error: "Failed to load Xero admin health snapshot" },
      { status: 500 }
    );
  }
}
