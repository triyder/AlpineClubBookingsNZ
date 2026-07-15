import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getPaymentIntent } from "@/lib/stripe";
import logger from "@/lib/logger";
import { hasAdminAccess } from "@/lib/access-roles";

/**
 * GET /api/bookings/[id]/additional-payment-secret
 * Returns the clientSecret for a pending additional modification payment.
 * Used by the booking detail page to render the Stripe payment form.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId } = await params;

  try {
    const payment = await prisma.payment.findUnique({
      where: { bookingId },
      include: { booking: { select: { memberId: true } } },
    });

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    if (
      payment.booking.memberId !== session.user.id &&
      !hasAdminAccess(session.user)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (
      !payment.additionalPaymentIntentId ||
      payment.additionalPaymentStatus === "SUCCEEDED"
    ) {
      return NextResponse.json(
        { error: "No pending additional payment" },
        { status: 404 }
      );
    }

    const pi = await getPaymentIntent(payment.additionalPaymentIntentId);
    if (!pi.client_secret) {
      return NextResponse.json(
        { error: "PaymentIntent has no client secret" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      clientSecret: pi.client_secret,
      amountCents: payment.additionalAmountCents,
    });
  } catch (err) {
    // #1888 — never echo an unexpected error's message to the client; the raw
    // error stays in the log only.
    logger.error({ err, bookingId }, "Failed to retrieve additional payment secret");
    return NextResponse.json(
      { error: "Failed to get payment secret" },
      { status: 500 }
    );
  }
}
