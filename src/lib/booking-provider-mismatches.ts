import type { BookingStatus, PaymentSource } from "@prisma/client";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import { getWaitlistOfferEmailDeliveries } from "@/lib/waitlist-offer-email-visibility";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";

/**
 * Issue #1089: per-booking provider-mismatch surfacing. The aggregate views
 * of these states already exist on /admin/stuck-states (xero-missing-invoices,
 * xero-refunds-missing-credit-notes, waitlist-offer-email-failures); this
 * answers the same questions for the one booking an admin is looking at, so
 * the mismatch is visible without scanning the dashboard.
 *
 * Read-only: detection mirrors the stuck-state queries and makes no provider
 * calls.
 */

type BookingProviderMismatchId =
  | "xero-invoice-pending"
  | "xero-credit-note-pending"
  | "waitlist-offer-email-failed";

export interface BookingProviderMismatch {
  id: BookingProviderMismatchId;
  label: string;
  description: string;
  href: string;
  linkLabel: string;
}

type MismatchBooking = {
  id: string;
  status: BookingStatus;
  deletedAt: Date | null;
  waitlistOfferedAt: Date | null;
  member: { email: string };
  payment: {
    id: string;
    source: PaymentSource;
    refundedAmountCents: number;
    xeroInvoiceId: string | null;
    xeroRefundCreditNoteId: string | null;
  } | null;
};

type BookingProviderMismatchDb = {
  booking: {
    findUnique(args: unknown): Promise<unknown>;
  };
  xeroSyncOperation: {
    count(args: unknown): Promise<number>;
  };
};

export interface BookingProviderMismatchDependencies {
  db: BookingProviderMismatchDb;
  loadEffectiveModuleFlags: typeof loadEffectiveModuleFlags;
  getWaitlistOfferEmailDeliveries: typeof getWaitlistOfferEmailDeliveries;
}

const defaultDependencies: BookingProviderMismatchDependencies = {
  db: prisma as unknown as BookingProviderMismatchDb,
  loadEffectiveModuleFlags,
  getWaitlistOfferEmailDeliveries,
};

export async function getBookingProviderMismatches(
  bookingId: string,
  input?: { deps?: Partial<BookingProviderMismatchDependencies> },
): Promise<BookingProviderMismatch[]> {
  const deps = { ...defaultDependencies, ...input?.deps };

  const booking = (await deps.db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      waitlistOfferedAt: true,
      member: { select: { email: true } },
      payment: {
        select: {
          id: true,
          source: true,
          refundedAmountCents: true,
          xeroInvoiceId: true,
          xeroRefundCreditNoteId: true,
        },
      },
    },
  })) as MismatchBooking | null;

  if (!booking || booking.deletedAt) {
    return [];
  }

  const modules = await deps.loadEffectiveModuleFlags();
  const mismatches: BookingProviderMismatch[] = [];

  if (modules.xeroIntegration && booking.payment) {
    if (booking.status === "PAID") {
      const succeededInvoiceOperations = await deps.db.xeroSyncOperation.count({
        where: {
          entityType: "INVOICE",
          status: "SUCCEEDED",
          localModel: "Payment",
          localId: booking.payment.id,
        },
      });

      if (succeededInvoiceOperations === 0) {
        mismatches.push({
          id: "xero-invoice-pending",
          label: "Paid, Xero invoice pending",
          description:
            "The money is received, but no completed Xero invoice operation exists for this payment yet. The outbox normally catches up on its own; if it stays pending, check the operation queue for a failure.",
          href: buildXeroRecordActivityUrl("Payment", booking.payment.id),
          linkLabel: "Review Xero activity",
        });
      }
    }

    if (
      booking.payment.source === "STRIPE" &&
      booking.payment.refundedAmountCents > 0 &&
      booking.payment.xeroInvoiceId !== null &&
      booking.payment.xeroRefundCreditNoteId === null
    ) {
      mismatches.push({
        id: "xero-credit-note-pending",
        label: "Refunded, Xero credit note pending",
        description:
          "A Stripe refund has been recorded but the matching Xero credit note has not been created yet, so the accounting ledger is behind the money movement.",
        href: buildXeroRecordActivityUrl("Payment", booking.payment.id),
        linkLabel: "Review Xero activity",
      });
    }
  }

  if (modules.waitlist && booking.status === "WAITLIST_OFFERED") {
    const deliveries = await deps.getWaitlistOfferEmailDeliveries([
      {
        id: booking.id,
        status: booking.status,
        waitlistOfferedAt: booking.waitlistOfferedAt,
        member: { email: booking.member.email },
      },
    ]);

    if (deliveries.get(booking.id)?.needsOperatorAction) {
      mismatches.push({
        id: "waitlist-offer-email-failed",
        label: "Waitlist offer email undelivered",
        description:
          "A place has been offered, but the offer email is missing, bounced, or exhausted its retries — the member may not know their offer is ticking down.",
        href: "/admin/waitlist",
        linkLabel: "Open waitlist queue",
      });
    }
  }

  return mismatches;
}
