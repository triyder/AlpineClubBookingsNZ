import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  BookingRequestQuoteError,
  holdBookingRequestSlots,
} from "@/lib/booking-request-quotes";
import { BookingRequestError } from "@/lib/booking-request";
import { requireAdmin } from "@/lib/session-guards";

const holdSchema = z.object({
  optionId: z.string().min(1).max(40).optional().nullable(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const parsed = holdSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  try {
    const result = await holdBookingRequestSlots({
      requestId: id,
      adminMemberId: session.user.id,
      optionId: parsed.data.optionId,
    });

    if (result.type === "capacityExceeded") {
      return NextResponse.json(
        {
          error: "The lodge is at capacity for one or more of the requested nights",
          fullNights: result.fullNights,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      bookingId: result.bookingId,
      reused: result.reused,
    });
  } catch (err) {
    if (err instanceof BookingRequestError || err instanceof BookingRequestQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
