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
 * Semantics (#1944 owner decision): manual mark-paid exists for cash payments
 * where NO Xero invoice exists. A subscription that carries a Xero invoice link
 * must be settled in Xero (record the payment against the invoice), so
 * direction "paid" is rejected with 409 when xeroInvoiceId is set, and a
 * NOT_REQUIRED row has nothing to pay so it is rejected too.
 *
 * Marking unpaid (reversal) is only permitted on a row this feature marked paid;
 * it restores the appropriate unpaid status — UNPAID when a Xero invoice link
 * still exists (the invoice is outstanding), NOT_INVOICED otherwise — and clears
 * the provenance columns.
 *
 * Both writes are status-fenced (conditional updateMany, 409 when no row
 * matches) so two admins clicking concurrently — or a Xero sync landing between
 * read and write — can never double-apply or clobber each other.
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
      // Owner-decided semantics (#1944): manual mark-paid is for cash payments
      // where no Xero invoice exists. Once an invoice links, Xero owns the
      // money state — recording the payment here would leave the invoice
      // outstanding in Xero and the two systems permanently disagreeing.
      if (subscription.xeroInvoiceId) {
        throw new ManualSubscriptionPaymentError(
          "This subscription has an outstanding Xero invoice — record the payment against the invoice in Xero instead.",
          409,
        );
      }
      // A NOT_REQUIRED row has nothing to pay, and marking it paid would lose
      // the policy-derived status with no way to restore it on reversal.
      if (subscription.status === "NOT_REQUIRED") {
        throw new ManualSubscriptionPaymentError(
          "This subscription is not required for this member — there is nothing to mark paid.",
          409,
        );
      }
      const now = new Date();
      // Status-fenced write: re-assert every guard inside the WHERE so a
      // concurrent second click, manual mark-paid, or Xero sync between the
      // read above and this write cannot double-apply or clobber (F4).
      const fenced = await tx.memberSubscription.updateMany({
        where: {
          id: subscription.id,
          status: { notIn: ["PAID", "NOT_REQUIRED"] },
          xeroInvoiceId: null,
          manuallyMarkedPaidAt: null,
        },
        data: {
          status: "PAID",
          paidAt: now,
          manuallyMarkedPaidAt: now,
          manuallyMarkedPaidByMemberId: input.actingMemberId,
          manualPaymentNote: note,
        },
      });
      if (fenced.count === 0) {
        throw new ManualSubscriptionPaymentError(
          "This subscription changed while you were marking it paid — refresh and try again.",
          409,
        );
      }
      const updated = await tx.memberSubscription.findUniqueOrThrow({
        where: { id: subscription.id },
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
    // Status-fenced write (F4): only a row still carrying manual provenance can
    // be reversed, so a concurrent reversal / Xero sync that already cleared it
    // 409s instead of silently re-applying.
    const fenced = await tx.memberSubscription.updateMany({
      where: {
        id: subscription.id,
        manuallyMarkedPaidAt: { not: null },
      },
      data: {
        status: restoredStatus,
        paidAt: null,
        manuallyMarkedPaidAt: null,
        manuallyMarkedPaidByMemberId: null,
        manualPaymentNote: null,
      },
    });
    if (fenced.count === 0) {
      throw new ManualSubscriptionPaymentError(
        "This subscription changed while you were reversing the manual payment — refresh and try again.",
        409,
      );
    }
    const updated = await tx.memberSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
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
          previousStatus: subscription.status,
          restoredStatus,
          hasXeroInvoiceLink: Boolean(subscription.xeroInvoiceId),
        },
      },
      tx,
    );
    return { ...updated, direction: "unpaid" as const };
  });
}
