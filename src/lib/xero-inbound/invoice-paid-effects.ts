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

type XeroInvoiceCashEvidence = "cash" | "none" | "indeterminate";

// A PAID invoice event alone is not cash (#1357/#1435): Xero also reports
// PAID when a credit note is ALLOCATED against the invoice — allocations
// accrue to amountCredited, never amountPaid, and the app's own
// invoice-clearing notes produce exactly that zero-cash PAID event on every
// ordinary unpaid-IB cancellation.
//
// Evidence order:
//  1. Overpayment/prepayment allocations count as cash: they are real member
//     money sitting on the Xero contact that an operator deliberately applied
//     (a standard bank-rec flow for transfers with mangled references). Xero
//     books them under amountCredited, but the app itself only ever produces
//     CREDIT-NOTE allocations, so these can never be the clearing-note echo
//     this gate exists to stop.
//  2. `amountPaid` is authoritative when present as a finite number — an
//     explicit 0 means Xero says no cash arrived, and the payments fallback
//     must NOT override it (stale entries could linger there).
//  3. The invoice's actual payment records are the fallback, ignoring
//     DELETED (reversed) payments.
//  4. A payload carrying none of these fields is "indeterminate" — the fresh
//     getInvoice fetch behind the only caller always carries the cash
//     fields, so this arm only guards degraded payload shapes.
function classifyXeroInvoiceCashEvidence(
  invoice: Invoice
): XeroInvoiceCashEvidence {
  if (
    (invoice.overpayments?.length ?? 0) > 0 ||
    (invoice.prepayments?.length ?? 0) > 0
  ) {
    return "cash";
  }
  if (
    typeof invoice.amountPaid === "number" &&
    Number.isFinite(invoice.amountPaid)
  ) {
    return Math.round(invoice.amountPaid * 100) > 0 ? "cash" : "none";
  }
  if (Array.isArray(invoice.payments)) {
    const cashPayments = invoice.payments.filter(
      (payment) => String(payment.status ?? "").toUpperCase() !== "DELETED"
    );
    return cashPayments.length > 0 ? "cash" : "none";
  }
  return "indeterminate";
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
    skippedNoCashEvidencePayments: 0,
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
  const paymentFilter = {
    source: PaymentSource.INTERNET_BANKING,
    OR: paymentWhere,
  };

  // #1435: settlement itself is cash-gated, not just credit minting (#1357).
  // Without positive cash evidence the loop settles NOTHING — no
  // PaymentTransaction/Payment SUCCEEDED flip, no booking PAID flip, no
  // member credit, no emails.
  const cashEvidence = classifyXeroInvoiceCashEvidence(invoice);
  const invoiceHasCashPayment = cashEvidence === "cash";
  if (!invoiceHasCashPayment) {
    // The app's own clearing-note echo (every ordinary unpaid-IB
    // cancellation) lands here, so this arm stays slim: no booking-graph
    // joins beyond what the admin alert below needs.
    const matchedPayments = await prisma.payment.findMany({
      where: paymentFilter,
      select: {
        id: true,
        amountCents: true,
        booking: {
          select: {
            status: true,
            checkIn: true,
            checkOut: true,
            member: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    result.matchedInternetBankingPayments = matchedPayments.length;
    if (matchedPayments.length === 0) {
      return result;
    }

    if (cashEvidence === "indeterminate") {
      // A payload carrying neither amountPaid nor payments proves nothing
      // either way. Throwing (rather than settling blind or skipping
      // terminally) hands the event to the inbound FAILED-retry machinery,
      // which re-fetches the invoice fresh on every sweep: a transient
      // degradation self-heals, and a persistent one surfaces as a loud,
      // operator-replayable FAILED event instead of a booking that silently
      // never settles (#1435 owner decision).
      logger.warn(
        { invoiceId, invoiceNumber, matchedPayments: matchedPayments.length },
        "Xero PAID invoice payload carried neither amountPaid nor payments; refusing to settle Internet Banking payments without cash evidence"
      );
      throw new Error(
        `Xero PAID invoice ${invoiceId} carried neither amountPaid nor payments; refusing to settle ${matchedPayments.length} Internet Banking payment(s) without cash evidence (#1435)`
      );
    }

    // Zero-cash PAID (credit-note allocation). Settle nothing — but keep the
    // linkage the pre-gate loop provided: stamp MISSING invoice identifiers
    // (never status) on the matched payments and their PRIMARY transactions,
    // so a later real-cash event for this invoice still matches them
    // (#1357's stale-invoice flow depends on that match). This also covers
    // the multi-payment case syncLinkedPaymentInvoiceMetadata deliberately
    // leaves alone (it only stamps a canonical single match).
    const matchedPaymentIds = matchedPayments.map((payment) => payment.id);
    await prisma.paymentTransaction.updateMany({
      where: {
        paymentId: { in: matchedPaymentIds },
        source: PaymentSource.INTERNET_BANKING,
        kind: PaymentTransactionKind.PRIMARY,
        xeroInvoiceId: null,
      },
      data: { xeroInvoiceId: invoiceId, xeroInvoiceNumber: invoiceNumber },
    });
    await prisma.payment.updateMany({
      where: { id: { in: matchedPaymentIds }, xeroInvoiceId: null },
      data: { xeroInvoiceId: invoiceId, xeroInvoiceNumber: invoiceNumber },
    });

    result.skippedNoCashEvidencePayments = matchedPayments.length;
    logger.info(
      { invoiceId, invoiceNumber, matchedPayments: matchedPayments.length },
      "Xero invoice reports PAID without cash payments (credit-note allocation); Internet Banking settlement skipped"
    );

    // An allocation-cleared invoice for a LIVE booking means an operator
    // cleared it Xero-side (e.g. wrote it off with a credit note) while the
    // booking still awaits payment in the app — under the default
    // non-holding config nothing will ever settle or expire that booking,
    // so tell the admins instead of parking it silently. The routine
    // clearing-note echo never fires this: its booking is already CANCELLED.
    for (const payment of matchedPayments) {
      if (
        payment.booking.status === BookingStatus.CANCELLED ||
        payment.booking.status === BookingStatus.PAID
      ) {
        continue;
      }
      await sendAdminPaymentFailureAlert({
        memberName: `${payment.booking.member.firstName} ${payment.booking.member.lastName}`,
        checkIn: payment.booking.checkIn,
        checkOut: payment.booking.checkOut,
        amountCents: payment.amountCents,
        errorMessage:
          "This booking's Xero invoice reports PAID via credit-note allocation, not a cash payment, so the app did not settle it and the booking still awaits payment. If the invoice was written off in Xero, cancel the booking in the app; if the member actually paid, record the cash payment against the invoice in Xero.",
        paymentIntentId: invoiceId,
      }).catch((err) =>
        logger.error(
          { err, paymentId: payment.id, invoiceId },
          "Failed to alert admins about an allocation-cleared invoice on a live booking"
        )
      );
    }
    return result;
  }

  const payments = await prisma.payment.findMany({
    where: paymentFilter,
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
          // Refunded rows keep their refund bookkeeping on replays (#1357).
          status: {
            notIn: [PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED],
          },
        },
        data: {
          status: PaymentStatus.SUCCEEDED,
          xeroInvoiceId: invoiceId,
          xeroInvoiceNumber: invoiceNumber,
        },
      });

      if (transactionUpdate.count === 0) {
        // A refunded PRIMARY row is excluded from the update above but still
        // exists — only mint a fresh SUCCEEDED row when none exists at all.
        const existingPrimary = await tx.paymentTransaction.findFirst({
          where: {
            paymentId: fresh.id,
            source: PaymentSource.INTERNET_BANKING,
            kind: PaymentTransactionKind.PRIMARY,
          },
          select: { id: true },
        });
        if (!existingPrimary) {
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
      }

      const paymentWasPending = fresh.status !== PaymentStatus.SUCCEEDED;
      // A PAID invoice event must never un-refund money (#1357, the #1353
      // raise-only spirit): a payment already (PARTIALLY_)REFUNDED keeps its
      // refund state on replays — only the invoice identifiers are refreshed.
      const paymentInRefundedState =
        fresh.status === PaymentStatus.REFUNDED ||
        fresh.status === PaymentStatus.PARTIALLY_REFUNDED;
      if (paymentWasPending || !fresh.xeroInvoiceId || fresh.xeroInvoiceNumber !== invoiceNumber) {
        await tx.payment.update({
          where: { id: fresh.id },
          data: {
            ...(paymentInRefundedState ? {} : { status: PaymentStatus.SUCCEEDED }),
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
        // A member paying the stale open invoice of an already-cancelled
        // booking (#1357, F17) must not land silently — but this branch is
        // reachable for EVERY cancelled booking whose invoice reports PAID,
        // and Xero also reports PAID when our own invoice-clearing credit
        // note is allocated (zero cash). Minting therefore requires ALL of:
        //  1. positive CASH evidence on the invoice (amountPaid, falling back
        //     to actual payment records) — an allocation-cleared invoice has
        //     credit applied, not cash, and must mint nothing. Since #1435
        //     the loop entry enforces this for every arm; the re-assert here
        //     is belt-and-braces for MINTING only (if the outer gate is ever
        //     reshaped, the settlement flips in the other arms are pinned by
        //     the #1435 regression tests, not by this condition);
        //  2. a payment that never settled (PENDING/FAILED) — a
        //     paid-then-cancelled booking's replayed event is old money that
        //     the cancellation flow already settled under its own policy;
        //  3. no credit already minted by THIS pipeline (matched by its own
        //     descriptions — never by amount, which collides with unrelated
        //     cancellation-flow rows and misses policy-tiered ones).
        const paymentNeverSettled =
          fresh.status === PaymentStatus.PENDING ||
          fresh.status === PaymentStatus.FAILED;
        const bookingLabel = fresh.bookingId.slice(0, 8);

        let credited = false;
        if (invoiceHasCashPayment && paymentNeverSettled && fresh.amountCents > 0) {
          const existingCredit = await tx.memberCredit.findFirst({
            where: {
              memberId: fresh.booking.memberId,
              sourceBookingId: fresh.bookingId,
              type: CreditType.CANCELLATION_REFUND,
              description: {
                in: [
                  `Internet Banking payment credit for booking ${bookingLabel}`,
                  `Internet Banking payment credit for cancelled booking ${bookingLabel}`,
                ],
              },
            },
            select: { id: true },
          });
          credited = !existingCredit;
        }

        if (credited) {
          await tx.memberCredit.create({
            data: {
              memberId: fresh.booking.memberId,
              amountCents: fresh.amountCents,
              type: CreditType.CANCELLATION_REFUND,
              description: `Internet Banking payment credit for cancelled booking ${bookingLabel}`,
              sourceBookingId: fresh.bookingId,
            },
          });
          // Real cash arrived, so the hold-expiry release's still-pending
          // invoice-clearing refund credit note (which would post a fictional
          // cash refund) is obsolete — retire it in the same transaction. An
          // already-executed note can't be retired here; the admin alert
          // below calls out that state for manual reconciliation.
          await tx.xeroSyncOperation.updateMany({
            where: {
              localModel: "Payment",
              localId: fresh.id,
              direction: "OUTBOUND",
              entityType: "CREDIT_NOTE",
              operationType: "CREATE",
              status: "PENDING",
              correlationKey: {
                startsWith: `payment:${fresh.id}:refund-credit-note:`,
              },
            },
            data: {
              status: "CANCELLED",
            },
          });
          await enqueueXeroAccountCreditNoteOperation(fresh.id, fresh.amountCents, {
            store: tx,
          });
        }

        return {
          type: "alreadyCancelled" as const,
          payment: fresh,
          paymentWasPending,
          credited,
          clearingNoteAlreadyIssued: Boolean(fresh.xeroRefundCreditNoteId),
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
      // Everything is gated on `credited` — the one state where new cash
      // actually landed and was minted. Replays, allocation-driven PAID flips
      // (our own clearing notes), and paid-then-cancelled histories all reach
      // this arm with credited=false and must stay silent.
      if (outcome.credited) {
        result.creditedInternetBankingBookings += 1;
        await recordBookingEvent({
          bookingId: outcome.payment.bookingId,
          type: BookingEventType.CREDITED,
          amountCents: outcome.payment.amountCents,
          reason:
            "Internet Banking payment received after cancellation; amount held as account credit.",
        });
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
            "Failed to email member about credit for payment on cancelled booking"
          )
        );
        sendAdminPaymentFailureAlert({
          memberName: `${outcome.payment.booking.member.firstName} ${outcome.payment.booking.member.lastName}`,
          checkIn: outcome.payment.booking.checkIn,
          checkOut: outcome.payment.booking.checkOut,
          amountCents: outcome.payment.amountCents,
          errorMessage: outcome.clearingNoteAlreadyIssued
            ? "Internet Banking payment was received for an already-cancelled booking. The amount is held as the member's account credit — and an invoice-clearing credit note was ALREADY issued for this invoice, so Xero needs manual reconciliation (void the clearing note's refund payment or the duplicate artifact)."
            : "Internet Banking payment was received for an already-cancelled booking. The amount is held as the member's account credit; follow up with the member if a bank refund is more appropriate.",
          paymentIntentId: invoiceId,
        }).catch((err) =>
          logger.error(
            { err, bookingId: outcome.payment.bookingId, paymentId: outcome.payment.id },
            "Failed to alert admins about Internet Banking payment on cancelled booking"
          )
        );
      }
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
    skippedNoCashEvidenceSettlements: 0,
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

  // #1435: the combined group invoice is subject to the same rule as the
  // per-payment loop above — a PAID event produced by credit-note allocation
  // (e.g. an operator writing the invoice off in Xero) carries zero cash and
  // must not flip a whole group of child bookings to PAID. The settlement
  // stays PENDING for the group-settlement reaper's normal expiry handling.
  const cashEvidence = classifyXeroInvoiceCashEvidence(invoice);
  if (cashEvidence !== "cash") {
    if (cashEvidence === "indeterminate") {
      // Same durable-deferral rule as the per-payment loop: hand the event
      // to the inbound FAILED-retry machinery rather than settling blind or
      // skipping terminally.
      logger.warn(
        { invoiceId, settlementId: settlement.id },
        "Xero PAID group settlement invoice payload carried neither amountPaid nor payments; refusing to settle without cash evidence"
      );
      throw new Error(
        `Xero PAID invoice ${invoiceId} carried neither amountPaid nor payments; refusing to settle group settlement ${settlement.id} without cash evidence (#1435)`
      );
    }
    result.skippedNoCashEvidenceSettlements = 1;
    logger.info(
      { invoiceId, settlementId: settlement.id },
      "Xero group settlement invoice reports PAID without cash payments (credit-note allocation); settlement skipped"
    );
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
