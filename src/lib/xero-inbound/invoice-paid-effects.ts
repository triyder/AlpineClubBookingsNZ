import { type Invoice } from "xero-node";
import { BookingEventType, BookingStatus, CreditType, PaymentSource, PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { sendAdminPaymentFailureAlert, sendBookingCancelledEmail, sendBookingConfirmedEmail } from "@/lib/email";
import { applyGroupSettlementSucceededFromInvoice } from "@/lib/group-settlement";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { recordBookingEvent } from "@/lib/booking-events";
import { processWaitlistForDates } from "@/lib/waitlist";
import { enqueueXeroAccountCreditNoteOperation } from "@/lib/xero-operation-outbox";
import { createAuditLog } from "@/lib/audit";

function isPaidXeroInvoice(invoice: Invoice): boolean {
  const status = String(invoice.status ?? "").toUpperCase();
  return status === "PAID" || Boolean(invoice.fullyPaidOnDate);
}

export async function syncInternetBankingPaymentsForPaidInvoice(
  invoice: Invoice,
  linkedPaymentIds: string[]
) {
  const invoiceId = invoice.invoiceID ?? null;
  const invoiceNumber = invoice.invoiceNumber ?? null;
  const result = {
    matchedInternetBankingPayments: 0,
    paidInternetBankingPayments: 0,
    paidInternetBankingBookings: 0,
    creditedInternetBankingBookings: 0,
    skippedAlreadyPaidBookings: 0,
  };

  if (!invoiceId || !isPaidXeroInvoice(invoice)) {
    return result;
  }

  const paymentWhere = [
    {
      xeroInvoiceId: invoiceId,
    },
    ...(linkedPaymentIds.length > 0
      ? [
          {
            id: {
              in: linkedPaymentIds,
            },
          },
        ]
      : []),
  ];
  const payments = await prisma.payment.findMany({
    where: {
      source: PaymentSource.INTERNET_BANKING,
      OR: paymentWhere,
    },
    include: {
      booking: {
        include: {
          member: true,
          guests: { include: { nights: true } },
          promoRedemption: {
            include: {
              promoCode: true,
            },
          },
        },
      },
    },
  });

  result.matchedInternetBankingPayments = payments.length;

  for (const payment of payments) {
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const fresh = await tx.payment.findUnique({
        where: { id: payment.id },
        include: {
          booking: {
            include: {
              member: true,
              guests: { include: { nights: true } },
              promoRedemption: { include: { promoCode: true } },
            },
          },
        },
      });

      if (!fresh || fresh.source !== PaymentSource.INTERNET_BANKING) {
        return { type: "missing" as const };
      }

      const transactionUpdate = await tx.paymentTransaction.updateMany({
        where: {
          paymentId: fresh.id,
          source: PaymentSource.INTERNET_BANKING,
          kind: PaymentTransactionKind.PRIMARY,
        },
        data: {
          status: PaymentStatus.SUCCEEDED,
          xeroInvoiceId: invoiceId,
          xeroInvoiceNumber: invoiceNumber,
        },
      });

      if (transactionUpdate.count === 0) {
        await tx.paymentTransaction.create({
          data: {
            paymentId: fresh.id,
            kind: PaymentTransactionKind.PRIMARY,
            source: PaymentSource.INTERNET_BANKING,
            stripePaymentIntentId: null,
            xeroInvoiceId: invoiceId,
            xeroInvoiceNumber: invoiceNumber,
            reference: fresh.reference ?? undefined,
            amountCents: fresh.amountCents,
            status: PaymentStatus.SUCCEEDED,
            reason: "xero_invoice_paid_reconciliation",
          },
        });
      }

      const paymentWasPending = fresh.status !== PaymentStatus.SUCCEEDED;
      if (paymentWasPending || !fresh.xeroInvoiceId || fresh.xeroInvoiceNumber !== invoiceNumber) {
        await tx.payment.update({
          where: { id: fresh.id },
          data: {
            status: PaymentStatus.SUCCEEDED,
            xeroInvoiceId: invoiceId,
            xeroInvoiceNumber: invoiceNumber,
          },
        });
      }

      if (fresh.booking.status === BookingStatus.PAID) {
        return {
          type: "alreadyPaid" as const,
          payment: fresh,
          paymentWasPending,
        };
      }

      if (fresh.booking.status === BookingStatus.CANCELLED) {
        return {
          type: "alreadyCancelled" as const,
          payment: fresh,
          paymentWasPending,
        };
      }

      if (
        fresh.booking.status === BookingStatus.PAYMENT_PENDING &&
        !fresh.internetBankingHoldSlots
      ) {
        const capacity = await checkCapacityForGuestRanges(
          fresh.booking.checkIn,
          fresh.booking.checkOut,
          fresh.booking.guests,
          fresh.booking.id,
          tx,
        );

        if (!capacity.available) {
          await tx.booking.update({
            where: { id: fresh.bookingId },
            data: {
              status: BookingStatus.CANCELLED,
              draftExpiresAt: null,
            },
          });
          await reconcileBedAllocationsForBooking({
            bookingId: fresh.bookingId,
            db: tx,
          });

          const creditDescription = `Internet Banking payment credit for booking ${fresh.bookingId.slice(0, 8)}`;
          const existingCredit = await tx.memberCredit.findFirst({
            where: {
              memberId: fresh.booking.memberId,
              sourceBookingId: fresh.bookingId,
              amountCents: fresh.amountCents,
              type: CreditType.CANCELLATION_REFUND,
              description: creditDescription,
            },
            select: { id: true },
          });
          if (!existingCredit && fresh.amountCents > 0) {
            await tx.memberCredit.create({
              data: {
                memberId: fresh.booking.memberId,
                amountCents: fresh.amountCents,
                type: CreditType.CANCELLATION_REFUND,
                description: creditDescription,
                sourceBookingId: fresh.bookingId,
              },
            });
          }

          // Enqueue the offsetting Xero account-credit note inside this same
          // transaction so the outbox intent commits atomically with the local
          // credit. Doing this post-commit risked a crash window that left a
          // local credit with no Xero mirror and no self-healing path (the
          // booking is now CANCELLED, so a re-run early-returns without
          // re-enqueueing). The enqueue is a local insert, no-ops when the
          // amount is <= 0, and dedups, so it is safe to run in-tx.
          await enqueueXeroAccountCreditNoteOperation(fresh.id, fresh.amountCents, {
            store: tx,
          });

          return {
            type: "capacityFailed" as const,
            payment: fresh,
            paymentWasPending,
            credited: !existingCredit && fresh.amountCents > 0,
          };
        }
      }

      await tx.booking.update({
        where: { id: fresh.bookingId },
        data: {
          status: BookingStatus.PAID,
          draftExpiresAt: null,
        },
      });
      await reconcileBedAllocationsForBooking({
        bookingId: fresh.bookingId,
        db: tx,
      });

      return {
        type: "paid" as const,
        payment: fresh,
        paymentWasPending,
      };
    });

    if (outcome.type === "missing") {
      continue;
    }

    if (outcome.paymentWasPending) {
      result.paidInternetBankingPayments += 1;
    }

    if (outcome.type === "alreadyPaid") {
      result.skippedAlreadyPaidBookings += 1;
      continue;
    }

    if (outcome.type === "alreadyCancelled") {
      continue;
    }

    if (outcome.type === "capacityFailed") {
      result.creditedInternetBankingBookings += 1;

      await recordBookingEvent({
        bookingId: outcome.payment.bookingId,
        type: BookingEventType.CANCELLED,
        amountCents: outcome.payment.amountCents,
        reason: "Internet Banking payment reconciled after capacity was no longer available.",
      });
      if (outcome.credited) {
        await recordBookingEvent({
          bookingId: outcome.payment.bookingId,
          type: BookingEventType.CREDITED,
          amountCents: outcome.payment.amountCents,
          reason: "Paid Internet Banking amount held as account credit.",
        });
      }

      // The Xero account-credit note is now enqueued inside the reconcile
      // transaction above (atomic with the local credit), so there is no
      // post-commit fire-and-forget enqueue here.
      sendAdminPaymentFailureAlert({
        memberName: `${outcome.payment.booking.member.firstName} ${outcome.payment.booking.member.lastName}`,
        checkIn: outcome.payment.booking.checkIn,
        checkOut: outcome.payment.booking.checkOut,
        amountCents: outcome.payment.amountCents,
        errorMessage:
          "Internet Banking payment reconciled, but the lodge no longer had capacity. The booking was cancelled and member account credit was created.",
        paymentIntentId: invoiceId,
      }).catch((err) =>
        logger.error(
          { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
          "Failed to alert admins about late Internet Banking capacity failure"
        )
      );
      sendBookingCancelledEmail(
        outcome.payment.booking.member.email,
        outcome.payment.booking.member.firstName,
        outcome.payment.booking.checkIn,
        outcome.payment.booking.checkOut,
        outcome.payment.amountCents,
        "credit",
      ).catch((err) =>
        logger.error(
          { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
          "Failed to email member about late Internet Banking cancellation"
        )
      );
      processWaitlistForDates({
        checkIn: outcome.payment.booking.checkIn,
        checkOut: outcome.payment.booking.checkOut,
      }).catch((err) =>
        logger.error(
          { err, bookingId: outcome.payment.bookingId },
          "Failed to process waitlist after late Internet Banking cancellation"
        )
      );
      continue;
    }

    result.paidInternetBankingBookings += 1;

    try {
      await createAuditLog({
        action: "booking.payment.confirmed",
        targetId: outcome.payment.bookingId,
        subjectMemberId: outcome.payment.booking.memberId,
        entityType: "Booking",
        entityId: outcome.payment.bookingId,
        category: "payment",
        outcome: "success",
        summary: "Internet Banking payment confirmed from Xero",
        details: JSON.stringify({
          source: "xero-inbound-invoice",
          paymentId: outcome.payment.id,
          xeroInvoiceId: invoiceId,
          xeroInvoiceNumber: invoiceNumber,
          amountCents: outcome.payment.amountCents,
          finalCapacityClaimed:
            outcome.payment.booking.status === BookingStatus.PAYMENT_PENDING &&
            !outcome.payment.internetBankingHoldSlots,
        }),
        metadata: {
          source: "xero-inbound-invoice",
          paymentId: outcome.payment.id,
          paymentSource: PaymentSource.INTERNET_BANKING,
          xeroInvoiceId: invoiceId,
          xeroInvoiceNumber: invoiceNumber,
          amountCents: outcome.payment.amountCents,
          finalCapacityClaimed:
            outcome.payment.booking.status === BookingStatus.PAYMENT_PENDING &&
            !outcome.payment.internetBankingHoldSlots,
        },
      });
    } catch (err) {
      logger.error(
        { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
        "Failed to audit Internet Banking payment reconciliation"
      );
    }

    await recordBookingEvent({
      bookingId: outcome.payment.bookingId,
      type: BookingEventType.MEMBER_PAID,
      amountCents: outcome.payment.amountCents,
      reason: "Internet Banking payment reconciled from Xero.",
    });

    sendBookingConfirmedEmail(
      outcome.payment.booking.member.email,
      outcome.payment.booking.member.firstName,
      outcome.payment.booking.checkIn,
      outcome.payment.booking.checkOut,
      outcome.payment.booking.guests.length,
      outcome.payment.booking.finalPriceCents,
      outcome.payment.booking.promoRedemption?.promoCode
        ? {
            discountCents: outcome.payment.booking.discountCents,
            promoAdjustmentCents: outcome.payment.booking.promoAdjustmentCents,
            promoCode: outcome.payment.booking.promoRedemption.promoCode.code,
          }
        : undefined
    ).catch((err) =>
      logger.error(
        { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
        "Failed to send booking confirmation email after Internet Banking reconciliation"
      )
    );
  }

  return result;
}

/**
 * Match a paid Xero invoice to an Internet Banking group settlement and, when
 * found, flip every joiner child booking to PAID. This is the settlement parallel
 * to `syncInternetBankingPaymentsForPaidInvoice`: a single combined invoice
 * settles the whole ORGANISER_PAYS group at once.
 */
export async function syncGroupSettlementForPaidInvoice(invoice: Invoice) {
  const invoiceId = invoice.invoiceID ?? null;
  const result = {
    matchedGroupSettlements: 0,
    settledGroupSettlements: 0,
    settledChildBookings: 0,
  };

  if (!invoiceId || !isPaidXeroInvoice(invoice)) {
    return result;
  }

  const settlement = await prisma.groupBookingSettlement.findFirst({
    where: {
      xeroInvoiceId: invoiceId,
      source: PaymentSource.INTERNET_BANKING,
    },
    select: { id: true, status: true },
  });

  if (!settlement) {
    return result;
  }

  result.matchedGroupSettlements = 1;
  if (settlement.status === PaymentStatus.SUCCEEDED) {
    return result;
  }

  try {
    const applied = await applyGroupSettlementSucceededFromInvoice(invoiceId);
    if (applied.outcome === "settled") {
      result.settledGroupSettlements = 1;
      result.settledChildBookings = applied.settledBookingIds.length;
    } else if (applied.outcome === "amount_mismatch") {
      // A child booking changed while the combined invoice sat open (#1033):
      // the bank transfer no longer matches what the children cost. Unlike
      // Stripe there is nothing to auto-refund, so alert the operators; the
      // settlement stays PENDING for manual reconciliation.
      logger.error(
        { invoiceId, settlementId: settlement.id },
        "Paid group settlement invoice no longer matches its children - operator review required"
      );
      const settlementDetail = await prisma.groupBookingSettlement.findUnique({
        where: { id: settlement.id },
        select: {
          amountCents: true,
          groupBooking: {
            select: {
              organiserMember: { select: { firstName: true, lastName: true } },
              organiserBooking: { select: { checkIn: true, checkOut: true } },
            },
          },
        },
      });
      await sendAdminPaymentFailureAlert({
        memberName: settlementDetail
          ? `${settlementDetail.groupBooking.organiserMember.firstName} ${settlementDetail.groupBooking.organiserMember.lastName}`
          : "Unknown group organiser",
        checkIn: settlementDetail?.groupBooking.organiserBooking.checkIn ?? new Date(),
        checkOut: settlementDetail?.groupBooking.organiserBooking.checkOut ?? new Date(),
        amountCents: settlementDetail?.amountCents ?? 0,
        errorMessage: `Group settlement invoice ${invoiceId} was paid, but a child booking changed while it was open so the total no longer matches. No bookings were settled; reconcile manually (short-pay/refund the difference or re-issue the settlement).`,
        paymentIntentId: invoiceId,
      }).catch((alertErr) =>
        logger.error(
          { err: alertErr, invoiceId, settlementId: settlement.id },
          "Failed to send admin alert for mismatched group settlement invoice"
        )
      );
    }
  } catch (err) {
    logger.error(
      { err, invoiceId, settlementId: settlement.id },
      "Failed to settle group booking from paid Xero invoice"
    );
  }

  return result;
}
