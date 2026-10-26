/**
 * Records the LIVE Xero status of every credit note linked as a Stripe
 * per-delta refund note (#2901 fix round, review F3).
 *
 * Why this exists: inbound reconciliation structurally cannot stamp
 * `metadata.status` onto an INACTIVE link — `reconcileXeroCreditNote` reaches
 * a payment's refund links only through ACTIVE links or the scalar pointer
 * (for writing a status; #4291 reads voided inactive mirrors for the recount only),
 * and there is no credit-note cursor — so the population the #2901 repair
 * wants to reactivate (links the pre-fix cleanup deactivated) never gains a
 * recorded status by itself, and the repair rightly refuses to reactivate an
 * unknown-status note. This recorder closes that gap with read-only provider
 * GETs: it fetches each linked note once and merges its snapshot
 * (`xeroCreditNoteSnapshotMetadata`, #4288) onto ALL of that note's
 * refund-note links, active or not, through the normal `upsertXeroObjectLink`
 * funnel.
 *
 * Provider safety: `getCreditNote` reads only — nothing is ever created,
 * voided, or deleted in Xero. Local writes are link metadata merges; the one
 * `active` transition it can cause is the funnel's own rule that the mirror
 * of a note reported VOIDED/DELETED lands inactive
 * (`normalizePaymentRefundLinkWithClient`) — the same thing an inbound
 * webhook for that note would do. A note the API cannot return stays
 * status-unknown and is recorded as a failure; the repair keeps refusing to
 * reactivate it (fail closed).
 */
import { PaymentSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import { xeroCreditNoteSnapshotMetadata } from "@/lib/xero-refund-note-status";

export interface StripeRefundNoteStatusRecordResult {
  scannedPayments: number;
  /** Distinct credit notes fetched from Xero. */
  checkedNotes: number;
  /** Link rows whose metadata was merged with the live status. */
  updatedLinks: number;
  failedNotes: Array<{ xeroObjectId: string; error: string }>;
}

interface RecordableLink {
  localId: string;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  active: boolean;
}

/**
 * Fetch and record live note statuses for the refund-note links of the given
 * refunded, Xero-invoiced Stripe payments (all of them when no ids are
 * given). The scan scope matches `findStripeRefundNoteLinkRepairs`.
 */
export async function recordStripeRefundNoteLinkStatuses(options?: {
  paymentIds?: string[];
}): Promise<StripeRefundNoteStatusRecordResult> {
  const payments = await prisma.payment.findMany({
    where: {
      source: PaymentSource.STRIPE,
      refundedAmountCents: { gt: 0 },
      xeroInvoiceId: { not: null },
      ...(options?.paymentIds && options.paymentIds.length > 0
        ? { id: { in: options.paymentIds } }
        : {}),
    },
    select: { id: true },
  });

  const result: StripeRefundNoteStatusRecordResult = {
    scannedPayments: payments.length,
    checkedNotes: 0,
    updatedLinks: 0,
    failedNotes: [],
  };
  if (payments.length === 0) {
    return result;
  }

  const links: RecordableLink[] = await prisma.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      localId: { in: payments.map((payment) => payment.id) },
      xeroObjectType: "CREDIT_NOTE",
      role: "REFUND_CREDIT_NOTE",
    },
    select: {
      localId: true,
      xeroObjectId: true,
      xeroObjectNumber: true,
      active: true,
    },
  });
  if (links.length === 0) {
    return result;
  }

  const linksByNoteId = new Map<string, RecordableLink[]>();
  for (const link of links) {
    const group = linksByNoteId.get(link.xeroObjectId) ?? [];
    group.push(link);
    linksByNoteId.set(link.xeroObjectId, group);
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  for (const [noteId, noteLinks] of linksByNoteId) {
    try {
      const response = await callXeroApi(
        () => xero.accountingApi.getCreditNote(tenantId, noteId),
        {
          operation: "getCreditNote",
          resourceType: "CREDIT_NOTE",
          workflow: "recordStripeRefundNoteLinkStatuses",
          context: `recordStripeRefundNoteLinkStatuses(${noteId})`,
        }
      );
      const creditNote = response.body.creditNotes?.[0];
      if (!creditNote?.creditNoteID) {
        throw new Error(`Xero credit note ${noteId} was not found`);
      }
      result.checkedNotes += 1;

      for (const link of noteLinks) {
        // Through the normal funnel: mergeMetadata preserves the outbound
        // {amountCents, watermarkCents}; `active` passes the CURRENT state so
        // recording is not a reactivation — except that the funnel itself
        // deactivates the mirror of a note reported VOIDED/DELETED, exactly
        // as an inbound webhook would.
        await upsertXeroObjectLink({
          localModel: "Payment",
          localId: link.localId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: noteId,
          xeroObjectNumber:
            creditNote.creditNoteNumber ?? link.xeroObjectNumber ?? null,
          role: "REFUND_CREDIT_NOTE",
          active: link.active,
          // #4288: stamped with its UpdatedDateUTC. `active` was read before
          // the fetch; a void committed since is kept under the row lock.
          metadata: xeroCreditNoteSnapshotMetadata(creditNote),
          mergeMetadata: true,
        });
        result.updatedLinks += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failedNotes.push({ xeroObjectId: noteId, error: message });
      logger.warn(
        { err: error, xeroObjectId: noteId },
        "Could not record live Xero status for a refund credit note (#2901); the repair will keep refusing to reactivate it"
      );
    }
  }

  return result;
}

/** Plain-text summary for the operator script. */
export function formatStripeRefundNoteStatusRecordResult(
  result: StripeRefundNoteStatusRecordResult
): string {
  const lines = [
    `Recorded live Xero statuses: ${result.checkedNotes} note(s) fetched, ${result.updatedLinks} link(s) updated across ${result.scannedPayments} payment(s).`,
  ];
  for (const failure of result.failedNotes) {
    lines.push(
      `  FAILED ${failure.xeroObjectId}: ${failure.error} — its links stay status-unknown and are never reactivated.`
    );
  }
  return lines.join("\n");
}
