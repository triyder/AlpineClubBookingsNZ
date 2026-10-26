import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession } from "@/lib/session-guards";
import { MAX_INVOICE_OBSERVATION_CURSOR_LENGTH } from "@/lib/booking-invoice-observation-cursor";
import { readBookingOutstandingAction } from "@/app/(authenticated)/bookings/[id]/_lib/booking-detail-outstanding";

/** One authenticated, cursor-bound supplementary invoice read; never a collection writer. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const cursor = request.nextUrl.searchParams.get("cursor");
  if (!cursor || cursor.length > MAX_INVOICE_OBSERVATION_CURSOR_LENGTH) return NextResponse.json({ error: "Invalid continuation" }, { status: 400 });
  try {
    const result = await readBookingOutstandingAction(id, guard.session.user.id, cursor);
    return NextResponse.json(result.view, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    // An unavailable authority read is not evidence that access was revoked.
    return NextResponse.json({ error: "Invoice observations unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
