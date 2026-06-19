import { NextRequest, NextResponse } from "next/server";
import { isActionTokenFormat } from "@/lib/action-tokens";
import { verifyAndCreateNonMemberJoin } from "@/lib/group-booking";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";

/**
 * Public: a non-member confirms their emailed token to finalise a group join.
 * Creates the non-login member, the PENDING child booking, a PENDING payment
 * and a tokenised pay link, then returns the pay token so the caller can send
 * the joiner to /pay/[token].
 *
 * POST (not GET) because it mutates: an email scanner or link-preview bot
 * pre-fetching the link must not create a booking. The service is idempotent,
 * so a genuine double-submit returns the existing booking rather than a second.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = applyRateLimit(rateLimiters.groupBookingToken, request);
  if (rateLimited) return rateLimited;

  const { token } = await params;
  if (!isActionTokenFormat(token)) {
    return NextResponse.json({ outcome: "invalid" }, { status: 404 });
  }

  try {
    const result = await verifyAndCreateNonMemberJoin(token);
    switch (result.outcome) {
      case "invalid":
        return NextResponse.json({ outcome: "invalid" }, { status: 404 });
      case "expired":
        return NextResponse.json({ outcome: "expired" }, { status: 410 });
      case "not_joinable":
        return NextResponse.json(
          { outcome: "not_joinable", message: result.message },
          { status: 409 }
        );
      case "capacity_full":
        return NextResponse.json(
          { outcome: "capacity_full", fullNights: result.fullNights },
          { status: 409 }
        );
      case "already_done":
        return NextResponse.json(
          { outcome: "already_done", bookingId: result.bookingId },
          { status: 200 }
        );
      case "created":
        return NextResponse.json(
          {
            outcome: "created",
            bookingId: result.bookingId,
            payToken: result.payToken,
            priceCents: result.priceCents,
            checkIn: result.checkIn.toISOString(),
            checkOut: result.checkOut.toISOString(),
            guestCount: result.guestCount,
          },
          { status: 201 }
        );
    }
  } catch (err) {
    logger.error({ err }, "Unexpected error verifying group join");
    return NextResponse.json(
      { error: "Unable to confirm your join right now" },
      { status: 500 }
    );
  }
}
