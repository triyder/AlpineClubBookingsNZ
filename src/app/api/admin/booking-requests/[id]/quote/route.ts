import { NextRequest, NextResponse } from "next/server";
import {
  bookingRequestQuoteInputSchema,
  BookingRequestQuoteError,
  createBookingRequestQuote,
  parseBookingRequestQuoteOptions,
} from "@/lib/booking-request-quotes";
import { BookingRequestError } from "@/lib/booking-request";
import { requireAdmin } from "@/lib/session-guards";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = bookingRequestQuoteInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  try {
    const quote = await createBookingRequestQuote({
      requestId: id,
      adminMemberId: session.user.id,
      quote: parsed.data,
    });

    return NextResponse.json({
      id: quote.id,
      version: quote.version,
      status: quote.status,
      pricingMode: quote.pricingMode,
      options: parseBookingRequestQuoteOptions(quote.options),
    });
  } catch (err) {
    if (err instanceof BookingRequestError || err instanceof BookingRequestQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
