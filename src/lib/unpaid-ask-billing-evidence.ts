/**
 * #3954 review round 6: WHAT XERO BILLED OF THE ASK A REDUCTION RETIRED,
 * DECIDED FROM EVIDENCE.
 *
 * A reduction set against an unpaid ask splits its offset between the smaller
 * re-issue's own invoice (decision A) and an invoice-correction note on the
 * primary invoice for what that invoice had already billed (owner decision
 * 10 Oct 2026, `splitUnpaidAskOffsetForXero`). Which part of the ask the
 * primary invoice billed used to be inferred from the supplementary invoices
 * found parked on it: anything not parked was "billed by the primary". But an
 * increase queues its supplementary invoice after its edit commits, so a
 * reduction saved moments later found none and credit-noted money no invoice
 * had billed.
 *
 * Now each row of the ask says how its money was billed:
 *
 * - a row's OWN money (its amount less what it carried) was asked by an
 *   increase. Its parked invoice covers it; without one, the asking edit's own
 *   answer to whether the primary invoice existed says which invoice bills it
 *   (round 7) - true, its supplementary invoice (still to be queued); false, the
 *   primary invoice raised afterwards. A row a failed mint's recovery minted
 *   reads that recovery's frozen answer (`hadIssuedXeroInvoice`, #3181); a row
 *   the edit's door minted reads the answer the door stamped on it. (Round 6
 *   dated the row's write against the primary invoice's link instead, which a
 *   recovery minting hours later, or a link backfilled later, gets wrong.)
 * - money a row carried from outside the chain is a re-issue's, or the
 *   re-issues an increase folded in: billed by their recorded invoices
 *   (`recordedReissuedAskInvoiceCents`), the rest by the primary invoice. The
 *   re-issue is found through the recovery that minted the row, or the
 *   increase through the fold its history records - or, for a row minted
 *   since round 8, through the edit its mint stamped on it;
 * - a waiting recovery's figures were recorded at its edit's save
 *   (`hadIssuedXeroInvoice`), and `retireUnpaidAskChain` has counted them.
 *
 * Where any of that cannot be established - an answer nobody recorded (a row
 * minted before round 7, or by the draining colour of that deploy), a row whose
 * carried figure does not add up, a carried part nothing names, or a carried
 * re-issue whose own reduction was itself unsure of its invoice (round 8) - the evidence
 * is `established: false`, and the edit records the offset, and what the
 * re-issue's invoice may still owe, for a person
 * (`unpaidAskBilledOffsetUnsureCents`, `reissuedAskInvoiceUnsureCents`) rather
 * than act on a guess.
 */
import type { Prisma } from "@prisma/client";
import { PaymentRecoveryOperationType } from "@prisma/client";

import type { RetiredUnpaidAsk, UnpaidPriceAskRow } from "@/lib/additional-ask-reduction";
import {
  bookingModificationIdForAdditionalIntentRecoveryKey,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
  REISSUED_ASK_REASON,
} from "@/lib/payment-recovery-keys";
import {
  recordedFoldedReissuedAskCents,
  recordedFoldedReissuedAskModificationIds,
  recordedReissuedAskInvoiceCents,
  recordedReissuedAskInvoiceUnsureCents,
} from "@/lib/unpaid-ask-offset-marker";

export type UnpaidAskBillingEvidence = {
  /** The ask's money a supplementary invoice bills or will bill - parked, or still to be queued. */
  supplementaryInvoicedCents: number;
  /** Whether the rest is established as billed by the primary invoice. */
  established: boolean;
};

/** The recovery that minted an intent: its edit, and that edit's frozen invoice answer. */
export type IntentMinter = { modificationId: string; hadIssuedXeroInvoice: boolean | null };

type EvidenceModification = {
  id: string;
  priceDiffCents: number;
  changeFeeCents: number;
  newData: unknown;
  createdAt: Date;
};

/** The pure reading, given what the loader read (`unpaidAskBillingEvidence`). */
export function classifyUnpaidAskBilling({
  rows,
  retired,
  modifications,
  intentMinters,
}: {
  rows: readonly UnpaidPriceAskRow[];
  retired: Pick<RetiredUnpaidAsk, "invoicedCents" | "parkedOps" | "invoiceEvidenceUnknown">;
  modifications: readonly EvidenceModification[];
  /** The recovery that minted each intent, by intent id; a door-minted row has none. */
  intentMinters: ReadonlyMap<string, IntentMinter>;
}): UnpaidAskBillingEvidence {
  let supplementaryInvoicedCents = retired.invoicedCents;
  let established = !retired.invoiceEvidenceUnknown;
  const modification = (id: string) => modifications.find((row) => row.id === id) ?? null;
  const isReduction = (id: string) => {
    const row = modification(id);
    return row !== null && row.priceDiffCents + row.changeFeeCents < 0;
  };

  rows.forEach((row, index) => {
    const previous = index > 0 ? rows[index - 1]! : null;
    const ownCents = row.amountCents - row.carriedAskCents;
    const carriedInCents = row.carriedAskCents - (previous?.amountCents ?? 0);
    if (ownCents < 0 || carriedInCents < 0) {
      established = false;
      return;
    }
    const parkedAnchors = retired.parkedOps.flatMap((op) =>
      op.intentId !== null && op.intentId === row.stripePaymentIntentId && op.anchorId ? [op.anchorId] : [],
    );
    if (ownCents > 0 && !parkedAnchors.some((anchorId) => !isReduction(anchorId))) {
      // Round 7: the asking edit's own answer - its recovery's, for a row a
      // recovery minted, else the one its door stamped on the row.
      const minter = row.stripePaymentIntentId ? intentMinters.get(row.stripePaymentIntentId) : undefined;
      const hadIssuedXeroInvoice = minter ? minter.hadIssuedXeroInvoice : row.hadIssuedXeroInvoice;
      if (hadIssuedXeroInvoice === null) established = false;
      else if (hadIssuedXeroInvoice) supplementaryInvoicedCents += ownCents;
    }
    if (carriedInCents > 0) {
      const reductions = carriedReissues(row, previous, carriedInCents);
      if (!reductions) {
        established = false;
        return;
      }
      for (const reductionId of reductions) {
        // Round 8: a re-issue whose own reduction could not establish what its
        // invoice owes (`reissuedAskInvoiceUnsureCents`) is no more certain
        // now: its recorded figure is only the part that reduction was sure of.
        if (recordedReissuedAskInvoiceUnsureCents(modification(reductionId)?.newData) > 0) established = false;
        if (parkedAnchors.includes(reductionId)) continue;
        supplementaryInvoicedCents += recordedReissuedAskInvoiceCents(modification(reductionId)?.newData);
      }
    }
  });
  return { supplementaryInvoicedCents, established };

  /** The reductions whose re-issued money a row carried in, or null where nothing names them. */
  function carriedReissues(
    row: UnpaidPriceAskRow,
    previous: UnpaidPriceAskRow | null,
    carriedInCents: number,
  ): string[] | null {
    // Round 8: the recovery that minted the row, else the edit its mint stamped on it.
    const minter =
      (row.stripePaymentIntentId ? intentMinters.get(row.stripePaymentIntentId)?.modificationId : undefined) ??
      row.bookingModificationId ??
      undefined;
    if (row.reason === REISSUED_ASK_REASON) {
      return minter && isReduction(minter) ? [minter] : null;
    }
    const increase = minter
      ? modification(minter)
      : (() => {
          const candidates = modifications.filter(
            (candidate) =>
              recordedFoldedReissuedAskCents(candidate.newData) === carriedInCents &&
              candidate.createdAt <= row.createdAt &&
              (!previous || candidate.createdAt > previous.createdAt),
          );
          return candidates.length === 1 ? candidates[0]! : null;
        })();
    if (!increase || recordedFoldedReissuedAskCents(increase.newData) !== carriedInCents) return null;
    return recordedFoldedReissuedAskModificationIds(increase.newData);
  }
}

/**
 * Read the evidence inside the reduction's transaction, after
 * `retireUnpaidAskChain`: the booking's edits and the recoveries that minted
 * the ask's rows, with their frozen invoice answers.
 */
export async function unpaidAskBillingEvidence(
  db: Pick<Prisma.TransactionClient, "bookingModification" | "paymentRecoveryOperation">,
  {
    bookingId,
    paymentId,
    rows,
    retired,
  }: {
    bookingId: string;
    paymentId: string;
    rows: readonly UnpaidPriceAskRow[];
    retired: Pick<RetiredUnpaidAsk, "invoicedCents" | "parkedOps" | "invoiceEvidenceUnknown">;
  },
): Promise<UnpaidAskBillingEvidence> {
  if (rows.length === 0) {
    return { supplementaryInvoicedCents: retired.invoicedCents, established: !retired.invoiceEvidenceUnknown };
  }
  const intentIds = rows.flatMap((row) => (row.stripePaymentIntentId ? [row.stripePaymentIntentId] : []));
  const modifications = await db.bookingModification.findMany({
    where: { bookingId },
    select: { id: true, priceDiffCents: true, changeFeeCents: true, newData: true, createdAt: true },
  });
  const recoveries =
    intentIds.length > 0
      ? await db.paymentRecoveryOperation.findMany({
          where: {
            paymentId,
            type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
            paymentIntentId: { in: intentIds },
          },
          select: { paymentIntentId: true, idempotencyKey: true, hadIssuedXeroInvoice: true },
        })
      : [];
  const intentMinters = new Map<string, IntentMinter>();
  for (const recovery of recoveries) {
    if (isEditFinancialReviewAdditionalIntentRecoveryKey(recovery.idempotencyKey)) continue;
    const modificationId = bookingModificationIdForAdditionalIntentRecoveryKey(recovery.idempotencyKey);
    if (modificationId) {
      intentMinters.set(recovery.paymentIntentId, {
        modificationId,
        hadIssuedXeroInvoice: recovery.hadIssuedXeroInvoice,
      });
    }
  }
  return classifyUnpaidAskBilling({ rows, retired, modifications, intentMinters });
}
