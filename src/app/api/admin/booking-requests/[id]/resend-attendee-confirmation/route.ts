import { NextRequest, NextResponse } from "next/server";
import {
  resendSchoolAttendeeConfirmation,
  SchoolAttendeeConfirmationError,
} from "@/lib/school-attendee-confirmation";
import { requireAdmin } from "@/lib/session-guards";

/**
 * Admin action (#1153): rotate the school attendee-confirmation token and
 * send the email now, outside the cron cadence.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;

  try {
    const result = await resendSchoolAttendeeConfirmation({
      bookingRequestId: id,
      adminMemberId: session.user.id,
    });
    return NextResponse.json({ success: true, sentTo: result.sentTo });
  } catch (err) {
    if (err instanceof SchoolAttendeeConfirmationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
