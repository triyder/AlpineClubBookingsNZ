import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { isXeroLocalModel } from "@/lib/xero-record-links";
import { getXeroRecordActivity } from "@/lib/xero-record-activity";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ localModel: string; localId: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { localModel, localId } = await params;
  if (!isXeroLocalModel(localModel) || !localId) {
    return NextResponse.json({ error: "Invalid Xero activity scope" }, { status: 400 });
  }

  try {
    const data = await getXeroRecordActivity(localModel, localId, 25);
    if (!data) {
      return NextResponse.json({ error: "Record not found" }, { status: 404 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    logger.error({ err, localModel, localId }, "Failed to load record-scoped Xero activity");
    return NextResponse.json(
      { error: "Failed to load record-scoped Xero activity" },
      { status: 500 }
    );
  }
}
