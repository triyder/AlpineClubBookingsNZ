import { NextRequest, NextResponse } from "next/server";
import { BookingRequestError } from "@/lib/booking-request";
import {
  BookingRequestQuoteError,
  parseBookingRequestQuoteOptions,
  sendBookingRequestQuote,
} from "@/lib/booking-request-quotes";
import {
  BookingMemberNightConflictError,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import { requireAdmin } from "@/lib/session-guards";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;

  try {
    const quote = await sendBookingRequestQuote({
      requestId: id,
      adminMemberId: session.user.id,
    });

    return NextResponse.json({
      success: true,
      id: quote.id,
      version: quote.version,
      status: quote.status,
      expiresAt: quote.responseTokenExpiresAt?.toISOString() ?? null,
      emailDelivered: quote.emailDelivered,
      options: parseBookingRequestQuoteOptions(quote.options),
    });
  } catch (err) {
    // Sending now auto-holds the beds (#1254), so the hold's guards can surface
    // here: a full lodge (BookingRequestQuoteError 409) or a linked-member
    // double-book (issue #1158). Return them as actionable 409s, not a 500.
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts),
        { status: 409 },
      );
    }
    if (err instanceof BookingRequestError || err instanceof BookingRequestQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
