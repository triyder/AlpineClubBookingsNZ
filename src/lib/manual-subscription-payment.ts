import "server-only";

import type { SubscriptionStatus } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

/**
 * E14 (#1944): audited manual mark-paid / mark-unpaid for a member subscription,
 * for clubs that do not use the Xero invoicing pipeline (or one-off cash
 * payments). This NEVER calls Xero and NEVER creates or voids an invoice — it
 * only writes the local MemberSubscription status plus provenance columns and an
 * audit-log entry recording the acting admin.
 *
 * Marking paid sets status = PAID with provenance (manuallyMarkedPaidAt / by /
 * note). A manually marked-paid member is then paid-up everywhere the app keys
 * off status === "PAID" (booking, nomination, member subscription status).
 *
 * Marking unpaid (reversal) is only permitted on a row this feature marked paid;
 * it restores the appropriate unpaid status — UNPAID when a Xero invoice link
 * still exists (the invoice is outstanding), NOT_INVOICED otherwise — and clears
 * the provenance columns.
 */
export class ManualSubscriptionPaymentError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ManualSubscriptionPaymentError";
    this.status = status;
  }
}

export const MANUAL_PAYMENT_NOTE_MAX = 500;

export type ManualPaymentDirection = "paid" | "unpaid";

export type ManualSubscriptionPaymentResult = {
  id: string;
  memberId: string;
  seasonYear: number;
  status: SubscriptionStatus;
  direction: ManualPaymentDirection;
};

export async function applyManualSubscriptionPayment(input: {
  subscriptionId: string;
  direction: ManualPaymentDirection;
  note?: string | null;
  actingMemberId: string;
}): Promise<ManualSubscriptionPaymentResult> {
  const trimmedNote = input.note?.trim() ? input.note.trim() : null;
  const note = trimmedNote ? trimmedNote.slice(0, MANUAL_PAYMENT_NOTE_MAX) : null;

  return prisma.$transaction(async (tx) => {
    const subscription = await tx.memberSubscription.findUnique({
      where: { id: input.subscriptionId },
      select: {
        id: true,
        memberId: true,
        seasonYear: true,
        status: true,
        xeroInvoiceId: true,
        manuallyMarkedPaidAt: true,
      },
    });
    if (!subscription) {
      throw new ManualSubscriptionPaymentError("Subscription not found", 404);
    }

    if (input.direction === "paid") {
      // Never overwrite a PAID status the Xero pipeline (or a prior manual
      // action) already owns.
      if (subscription.status === "PAID") {
        throw new ManualSubscriptionPaymentError(
          "This subscription is already marked paid.",
          409,
        );
      }
      const now = new Date();
      const updated = await tx.memberSubscription.update({
        where: { id: subscription.id },
        data: {
          status: "PAID",
          paidAt: now,
          manuallyMarkedPaidAt: now,
          manuallyMarkedPaidByMemberId: input.actingMemberId,
          manualPaymentNote: note,
        },
        select: { id: true, memberId: true, seasonYear: true, status: true },
      });
      await createAuditLog(
        {
          action: "membership-subscription.manual-payment.mark-paid",
          memberId: input.actingMemberId,
          actorMemberId: input.actingMemberId,
          subjectMemberId: subscription.memberId,
          targetId: subscription.id,
          entityType: "MemberSubscription",
          entityId: subscription.id,
          category: "payment",
          severity: "important",
          outcome: "success",
          summary: "Membership subscription manually marked paid",
          details: note,
          metadata: {
            subscriptionId: subscription.id,
            memberId: subscription.memberId,
            seasonYear: subscription.seasonYear,
            previousStatus: subscription.status,
            hasXeroInvoiceLink: Boolean(subscription.xeroInvoiceId),
          },
        },
        tx,
      );
      return { ...updated, direction: "paid" as const };
    }

    // direction === "unpaid": reversal, only on a row this feature marked paid.
    if (!subscription.manuallyMarkedPaidAt) {
      throw new ManualSubscriptionPaymentError(
        "Only a manually marked-paid subscription can be reversed here.",
        409,
      );
    }
    const restoredStatus: SubscriptionStatus = subscription.xeroInvoiceId
      ? "UNPAID"
      : "NOT_INVOICED";
    const updated = await tx.memberSubscription.update({
      where: { id: subscription.id },
      data: {
        status: restoredStatus,
        paidAt: null,
        manuallyMarkedPaidAt: null,
        manuallyMarkedPaidByMemberId: null,
        manualPaymentNote: null,
      },
      select: { id: true, memberId: true, seasonYear: true, status: true },
    });
    await createAuditLog(
      {
        action: "membership-subscription.manual-payment.mark-unpaid",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: subscription.memberId,
        targetId: subscription.id,
        entityType: "MemberSubscription",
        entityId: subscription.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: "Manual membership subscription payment reversed",
        details: note,
        metadata: {
          subscriptionId: subscription.id,
          memberId: subscription.memberId,
          seasonYear: subscription.seasonYear,
          restoredStatus,
          hasXeroInvoiceLink: Boolean(subscription.xeroInvoiceId),
        },
      },
      tx,
    );
    return { ...updated, direction: "unpaid" as const };
  });
}
