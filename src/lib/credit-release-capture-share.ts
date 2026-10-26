import "server-only";

import type { Prisma } from "@prisma/client";
import { PaymentTransactionKind } from "@prisma/client";

import { planCreditReleasePayments, type AskLedgerRow } from "@/lib/credit-release-payment-plan";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { prisma } from "@/lib/prisma";

/**
 * HOW MUCH OF ONE CARD CAPTURE THE CREDIT-RELEASE SWEEP RECORDS (#4253,
 * `INV-ADDPAY-046`), so the capture's receipt writer records only the rest.
 *
 * Two writers could otherwise record the same card payment on the booking's
 * invoice: the sweep (`credit-release-xero-payment.ts`) and the additional-capture
 * receipt (`additional-capture-recorder.ts`). Both derive their share from the
 * same ledger chain, so they cannot disagree about it and neither depends on the
 * other having run. `held` means the sweep will not record this capture and an
 * officer has been told: the receipt stands down too, rather than record a payment
 * that may include money nobody has worked out.
 */
export type CreditReleaseCaptureShare = { ownCents: number; held: boolean };

export async function readCreditReleaseCaptureShare(
  paymentIntentId: string,
  store: Pick<Prisma.TransactionClient, "paymentTransaction"> = prisma,
): Promise<CreditReleaseCaptureShare> {
  const capture = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { paymentId: true },
  });
  if (!capture) return { ownCents: 0, held: false };
  const rows = await store.paymentTransaction.findMany({
    where: { paymentId: capture.paymentId, kind: PaymentTransactionKind.ADDITIONAL },
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: {
      id: true,
      source: true,
      status: true,
      reason: true,
      amountCents: true,
      carriedAskCents: true,
      withdrawnAt: true,
      stripePaymentIntentId: true,
    },
  });
  const plan = planCreditReleasePayments(rows as AskLedgerRow[]);
  return {
    ownCents: plan.items
      .filter((item) => item.capturedByIntentId === paymentIntentId)
      .reduce((sum, item) => sum + item.ownCents, 0),
    held: plan.unexplainedCaptureIntentIds.includes(paymentIntentId),
  };
}
