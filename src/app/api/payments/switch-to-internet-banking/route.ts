import { NextRequest, NextResponse } from "next/server";
import { BookingStatus, PaymentSource, PaymentStatus } from "@prisma/client";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";
import { CreatePaymentIntentSchema } from "@/types/payments";
import { canCreateImmediatePaymentIntent } from "@/lib/booking-payment-flow";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import {
  buildInternetBankingHoldUntil,
  checkInternetBankingLeadTime,
  loadInternetBankingPaymentSettings,
} from "@/lib/internet-banking-settings";
import { recordInternetBankingPaymentTransaction } from "@/lib/payment-transactions";
import { cancelPaymentIntentIfCancellable } from "@/lib/stripe";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { isXeroConnected } from "@/lib/xero";
import logger from "@/lib/logger";
import { hasAdminAccess } from "@/lib/access-roles";

/**
 * Switch an existing card (Stripe) PAYMENT_PENDING booking to Internet Banking.
 *
 * Mirrors the booking-create Internet Banking branch for an already-created
 * booking: flips its Payment to PaymentSource.INTERNET_BANKING with a BOOKING-
 * reference, voids any open Stripe intent, and raises + emails the Xero invoice.
 * The booking stays PAYMENT_PENDING until Xero inbound reconciliation marks it
 * PAID, exactly like a booking created with Internet Banking. Internet Banking is
 * an optional module, so this 400s when it is off.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = CreatePaymentIntentSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const modules = await loadEffectiveModuleFlags();
  if (!modules.xeroIntegration || !modules.internetBankingPayments) {
    return NextResponse.json(
      { error: "Internet Banking payments are not available." },
      { status: 400 }
    );
  }

  const { bookingId } = parsed.data;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      payment: true,
      guests: { include: { nights: true } },
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (booking.memberId !== session.user.id && !hasAdminAccess(session.user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (booking.organiserSettled) {
    return NextResponse.json(
      {
        error:
          "This booking is paid by the group organiser and cannot be paid individually",
      },
      { status: 400 }
    );
  }

  const reference = buildInternetBankingPaymentReference(booking.id);

  // Already on Internet Banking → idempotent success.
  if (booking.payment?.source === PaymentSource.INTERNET_BANKING) {
    return NextResponse.json({
      reference,
      holdBedSlots: booking.payment.internetBankingHoldSlots,
      holdUntil: booking.payment.internetBankingHoldUntil,
    });
  }

  const internetBankingSettings = await loadInternetBankingPaymentSettings();
  const leadTime = checkInternetBankingLeadTime({
    checkIn: booking.checkIn,
    settings: internetBankingSettings,
  });
  if (!leadTime.allowed) {
    return NextResponse.json(
      {
        error: leadTime.unavailableReason ?? "Internet Banking is not available for this check-in date.",
        code: "INTERNET_BANKING_CUTOFF",
        minimumDaysBeforeCheckIn: leadTime.minimumDaysBeforeCheckIn,
        checkIn: leadTime.checkIn,
      },
      { status: 400 },
    );
  }

  // Only an immediately-payable (charge-now) booking can switch; a saved-card
  // hold or organiser-settled / draft booking cannot.
  if (
    booking.status !== "PAYMENT_PENDING" ||
    !canCreateImmediatePaymentIntent({
      status: booking.status,
      hasNonMembers: booking.hasNonMembers,
      organiserSettled: booking.organiserSettled,
    })
  ) {
    return NextResponse.json(
      { error: "This booking cannot switch to Internet Banking." },
      { status: 400 }
    );
  }
  if (booking.finalPriceCents <= 0) {
    return NextResponse.json(
      { error: "This booking has nothing to pay." },
      { status: 400 }
    );
  }
  if (booking.payment?.status === PaymentStatus.SUCCEEDED) {
    return NextResponse.json(
      { error: "This booking has already been paid." },
      { status: 400 }
    );
  }

  // Void any open Stripe intent so the member can't also be charged by card.
  if (booking.payment?.stripePaymentIntentId) {
    try {
      await cancelPaymentIntentIfCancellable(booking.payment.stripePaymentIntentId);
    } catch (err) {
      logger.error(
        { err, bookingId },
        "Failed to cancel Stripe intent while switching to Internet Banking"
      );
    }
  }

  const amountCents = booking.finalPriceCents;
  const holdBedSlots = internetBankingSettings.holdBedSlots;
  const holdUntil = buildInternetBankingHoldUntil(internetBankingSettings);
  const paymentResult = await prisma.$transaction(async (tx) => {
    const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    if (holdBedSlots) {
      const capacity = await checkCapacityForGuestRanges(
        bookingLodgeId,
        booking.checkIn,
        booking.checkOut,
        booking.guests,
        booking.id,
        tx,
      );
      if (!capacity.available) {
        return { type: "capacityExceeded" as const };
      }
    }

    const payment = await tx.payment.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        amountCents,
        source: PaymentSource.INTERNET_BANKING,
        reference,
        status: PaymentStatus.PENDING,
        internetBankingHoldSlots: holdBedSlots,
        internetBankingHoldUntil: holdUntil,
        internetBankingHoldReleasedAt: null,
      },
      update: {
        amountCents,
        source: PaymentSource.INTERNET_BANKING,
        reference,
        status: PaymentStatus.PENDING,
        stripePaymentIntentId: null,
        internetBankingHoldSlots: holdBedSlots,
        internetBankingHoldUntil: holdUntil,
        internetBankingHoldReleasedAt: null,
      },
    });

    if (holdBedSlots) {
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.CONFIRMED },
      });
      await reconcileBedAllocationsForBooking({
        bookingId: booking.id,
        db: tx,
      });
    }

    await recordInternetBankingPaymentTransaction({
      paymentId: payment.id,
      amountCents,
      status: PaymentStatus.PENDING,
      reference,
      reason: "internet_banking_switch_at_pay",
      store: tx,
    });

    return { type: "updated" as const, payment };
  });

  if (paymentResult.type === "capacityExceeded") {
    return NextResponse.json(
      {
        error: "The lodge is fully booked on some of your requested dates.",
        code: "CAPACITY_EXCEEDED",
      },
      { status: 409 },
    );
  }

  try {
    const queued = await enqueueXeroBookingInvoiceOperation(booking.id, {
      createdByMemberId: session.user.id,
    });
    if (queued.queueOperationId && (await isXeroConnected())) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    }
  } catch (err) {
    logger.error(
      { err, bookingId },
      "Failed to queue Xero invoice after switching to Internet Banking"
    );
  }

  return NextResponse.json({
    reference,
    holdBedSlots,
    holdUntil,
  });
}
