import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { GroupBookingError } from "@/lib/group-booking";
import { createGroupSettlementIntent } from "@/lib/group-settlement";
import logger from "@/lib/logger";

/**
 * Organiser action: start (or resume) settling an ORGANISER_PAYS group as one
 * combined bill. Commits the joiners' child bookings to CONFIRMED (capacity
 * held) and returns a Stripe client secret for the combined total so the
 * organiser can pay. Ownership and payment mode are enforced in the service.
 *
 * Mutating, so POST: it both holds beds and opens a PaymentIntent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const rateLimited = applyRateLimit(rateLimiters.groupBookingCreate, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { code } = await params;
  try {
    const result = await createGroupSettlementIntent(code, session.user.id);
    return NextResponse.json({
      outcome: result.outcome,
      amountCents: result.amountCents,
      childCount: result.childCount,
      clientSecret: result.clientSecret ?? null,
      paymentIntentId: result.paymentIntentId ?? null,
    });
  } catch (err) {
    if (err instanceof GroupBookingError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status: err.status }
      );
    }
    logger.error({ err }, "Unexpected error settling group booking");
    return NextResponse.json(
      { error: "Unable to settle the group booking right now" },
      { status: 500 }
    );
  }
}
