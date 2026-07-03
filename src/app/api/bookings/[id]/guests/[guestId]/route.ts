import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  BookingGuestRemovalError,
  removeBookingGuestInTransaction,
} from "@/lib/booking-guest-removal-service";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
} from "@/lib/membership-type-policy";
import { executeBookingModificationRefund } from "@/lib/booking-modification-settlement";
import { authorizationRoleFromAccessRoles } from "@/lib/access-roles";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; guestId: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId, guestId } = await params;
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  const body = await request.json().catch(() => null);
  const rawSettlementMethod = (body as { settlementMethod?: unknown } | null)
    ?.settlementMethod;
  if (
    rawSettlementMethod !== undefined &&
    rawSettlementMethod !== "card" &&
    rawSettlementMethod !== "credit"
  ) {
    return NextResponse.json(
      { error: "settlementMethod must be 'card' or 'credit'" },
      { status: 400 },
    );
  }
  const settlementMethod = rawSettlementMethod as
    | BookingModificationSettlementMethod
    | undefined;

  try {
    const result = await prisma.$transaction((tx) =>
      removeBookingGuestInTransaction({
        tx,
        bookingId,
        guestId,
        actorMemberId: session.user.id,
        actorRole: authorizationRoleFromAccessRoles(session.user),
        settlementMethod,
      })
    );

    // Process the Stripe refund outside the transaction (avoids holding the
    // advisory lock during the Stripe API call). Only the Stripe-refundable
    // slice (pendingRefundAmountCents) is charged back; account credit and
    // non-Stripe captured payments never issue a Stripe refund. The shared
    // helper scopes the idempotency key to this modification and enqueues
    // durable recovery on failure (issue #818).
    const stripeRefundId = await executeBookingModificationRefund({
      bookingId,
      result,
      metadataReason: "guest_removed_price_decrease",
      idempotencyKeyPrefix: `guest_remove_refund_${bookingId}`,
      failureMessage:
        "Stripe refund failed after guest removal - enqueueing recovery",
      recoveryFailureMessage:
        "Failed to enqueue guest-removal refund recovery - manual reconciliation required",
    });

    // Audit log
    logAudit({
      action: "booking.modify.guests.remove",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: result.booking.memberId,
      entityType: "BookingModification",
      entityId: result.bookingModificationId,
      category: "booking",
      outcome: "success",
      summary: "Booking guest removed",
      details: JSON.stringify({
        removedGuest: `${result.removedGuest.firstName} ${result.removedGuest.lastName}`,
        priceDiffCents: result.priceDiffCents,
        refundAmountCents: result.refundAmountCents,
        accountCreditAmountCents: result.accountCreditAmountCents,
        settlementMethod: result.settlementMethod,
        policyRetainedAmountCents: result.policyRetainedAmountCents,
        choreWarnings: result.choreWarnings,
      }),
      metadata: {
        bookingId,
        removedGuest: `${result.removedGuest.firstName} ${result.removedGuest.lastName}`,
        priceDiffCents: result.priceDiffCents,
        refundAmountCents: result.refundAmountCents,
        accountCreditAmountCents: result.accountCreditAmountCents,
        settlementMethod: result.settlementMethod,
        policyRetainedAmountCents: result.policyRetainedAmountCents,
        choreWarnings: result.choreWarnings,
        newGuestCount: result.booking.guests.length,
      },
      ipAddress,
    });

    void queueXeroBookingEditSettlement({
      bookingId,
      bookingModificationId: result.bookingModificationId,
      createdByMemberId: session.user.id,
      hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
      originalPaymentStatus: result.paymentStatus,
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: 0,
      datesChanged: false,
      // Policy-limited settlement amount + method so a captured-payment
      // reduction issues the correct (card vs credit) modification credit
      // note; an unpaid issued invoice falls back to the full delta inside
      // classifyXeroBookingEditSettlement when this is null.
      settlementAmountCents: result.xeroRefundAmountCents,
      settlementMethod: result.settlementMethod,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to queue Xero settlement for guest removal")
    );

    // Send email
    const member = await prisma.member.findUnique({
      where: { id: result.booking.memberId },
    });
    if (member) {
      sendBookingModifiedEmail({
        email: member.email,
        firstName: member.firstName,
        modificationType: "GUEST_REMOVE",
        oldCheckIn: result.booking.checkIn,
        oldCheckOut: result.booking.checkOut,
        newCheckIn: result.booking.checkIn,
        newCheckOut: result.booking.checkOut,
        oldGuestCount: result.oldGuestCount,
        newGuestCount: result.booking.guests.length,
        oldFinalPriceCents: result.booking.finalPriceCents - result.priceDiffCents,
        newFinalPriceCents: result.booking.finalPriceCents,
        changeFeeCents: 0,
        refundAmountCents: result.refundAmountCents,
        accountCreditAmountCents: result.accountCreditAmountCents,
        // Removing a guest can raise the price when it invalidates a group
        // promo the remaining guests relied on. Only the issued-invoice
        // (Internet Banking) path actually bills that increase — via a Xero
        // supplementary invoice — so only surface it there. On a Stripe booking
        // this endpoint has no mechanism to collect it (tracked in #1042), and
        // an "additional payment required" note with no way to pay is worse
        // than saying nothing; the price change still shows via old/new total.
        additionalAmountCents: result.hasIssuedXeroInvoice
          ? result.additionalAmountCents
          : 0,
        additionalPaymentMethod:
          result.hasIssuedXeroInvoice && result.additionalAmountCents > 0
            ? "INTERNET_BANKING"
            : undefined,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to send booking modified email")
      );
    }

    return NextResponse.json({
      booking: result.booking,
      removedGuest: result.removedGuest,
      priceDiffCents: result.priceDiffCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      settlementMethod: result.settlementMethod,
      policyRetainedAmountCents: result.policyRetainedAmountCents,
      stripeRefundId: stripeRefundId ?? null,
      promoRemoved: result.promoRemoved,
      choreWarnings: result.choreWarnings,
    });
  } catch (err) {
    if (err instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    if (err instanceof BookingGuestRemovalError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message =
      err instanceof Error ? err.message : "Failed to remove guest";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
