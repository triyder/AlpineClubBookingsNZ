import { NextRequest, NextResponse } from "next/server";
import {
  BookingRequestQuoteError,
  parseBookingRequestQuoteOptions,
  sendBookingRequestQuote,
} from "@/lib/booking-request-quotes";
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
      options: parseBookingRequestQuoteOptions(quote.options),
    });
  } catch (err) {
    if (err instanceof BookingRequestQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
