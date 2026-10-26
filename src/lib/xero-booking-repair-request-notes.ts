import type { ClubFormat } from "@/lib/club-format";
import { readRefundRequestIdFromOperation, readRefundRequestIdFromPayload, REFUND_REQUEST_CREDIT_NOTE_ROLE } from "@/lib/refund-request-credit-note";
import { formatCents } from "@/lib/utils";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import type { BookingClassificationContext, BookingXeroRepairAction, MutableFinding } from "./xero-booking-repair-types";
import { addAction, addFinding, buildManualReviewAction } from "./xero-booking-repair-findings";
import { readJsonRecord } from "./xero-booking-repair-utils";

/** #4215 (`INV-PAY-118`): the cash this booking's payment paid back on refund requests, which no cancellation note answers. */
export function paidBackRefundRequestCents(context: Pick<BookingClassificationContext, "paidBackRefundRequests">): number {
  return context.paidBackRefundRequests.reduce((sum, request) => sum + request.amountCents, 0);
}

/** Each request's amount in the club's format, for the finding's wording; set after the load. */
export function labelPaidBackRefundRequests<C extends Pick<BookingClassificationContext, "paidBackRefundRequests">>(context: C, format: ClubFormat): C {
  return {
    ...context,
    paidBackRefundRequests: context.paidBackRefundRequests.map((request) => ({ ...request, amountLabel: formatCents(request.amountCents, format) })),
  };
}

type ArmContext = Pick<
  BookingClassificationContext,
  "booking" | "paidBackRefundRequests" | "paymentOperations" | "paymentLinks" | "everRefundNoteLinked"
>;

/**
 * #4231 lens round 3: DOES THIS PAYMENT HAVE A CANCELLATION REFUND NOTE OF ANY
 * KIND - its pointer, a `REFUND_CREDIT_NOTE` link active or not, or a refund-note
 * create row that is no request's, whatever its status? Only with none can
 * nothing have been folded into it. No amount is read: an amount recorded here
 * goes stale the moment an officer edits the note in Xero.
 */
function hasCancellationRefundNote(context: ArmContext): boolean {
  const payment = context.booking.payment!;
  if (payment.xeroRefundCreditNoteId) return true;
  if (context.everRefundNoteLinked) return true;
  return context.paymentOperations.some((operation) => {
    if (operation.entityType !== "CREDIT_NOTE" || operation.operationType !== "CREATE") return false;
    if (readRefundRequestIdFromOperation(operation) !== null) return false;
    const queueType = operation.queueType ?? readJsonRecord(operation.requestPayload)?.queueType ?? null;
    // A legacy row naming no queue type may be a refund note: counted.
    return queueType === null || queueType === XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE;
  });
}

/**
 * #4231 (`INV-PAY-118`, D-3813-8): A REFUND REQUEST PAID BACK BEFORE THE
 * BOOKING HAD AN INVOICE. Its completion queues the request's own note only
 * against an invoice (`refundRequestCreditNoteAsk`), so once the invoice exists
 * nothing else would credit it: Xero would hold the invoice under-credited by
 * the request's cash, which the cancellation's note never answers either.
 *
 * ONLY for a request with no request-note CREATE row at all and no
 * request-note link: a request whose note was raised and then voided in Xero
 * has its row, and its re-raise is an officer's decision (#4195, #4214).
 *
 * Never auto-applied: a credit raised by hand in Xero is invisible here. With
 * no cancellation refund note of any kind, the request's own note is offered
 * through the completion's enqueue, keyed by the request, for an officer to
 * confirm (`--apply-action`) once they have checked Xero. With one, before
 * #4231 the tool or an officer could have sized it with the request's cash
 * folded in, and only Xero can say: the finding goes to a person, with how to
 * check and what to do either way, and no action. A request's note has no
 * resolved-in-Xero path without an outbox row of its own, so a credit raised
 * by hand leaves the finding standing.
 */
export function addRefundRequestNoteNotQueuedFindings({
  findings,
  actionMap,
  context,
}: {
  findings: MutableFinding[];
  actionMap: Map<string, BookingXeroRepairAction>;
  context: ArmContext;
}): void {
  const payment = context.booking.payment;
  if (!payment?.xeroInvoiceId) return;
  const missing = context.paidBackRefundRequests.filter((request) => {
    if (request.paymentId !== payment.id || request.amountCents <= 0) return false;
    const noteAsked =
      context.paymentOperations.some(
        (operation) =>
          operation.entityType === "CREDIT_NOTE" &&
          operation.operationType === "CREATE" &&
          readRefundRequestIdFromOperation(operation) === request.refundRequestId,
      ) ||
      context.paymentLinks.some(
        (link) =>
          link.role === REFUND_REQUEST_CREDIT_NOTE_ROLE && readRefundRequestIdFromPayload(link.metadata) === request.refundRequestId,
      );
    return !noteAsked;
  });
  if (missing.length === 0) return;
  const cancellationNote = hasCancellationRefundNote(context);

  for (const request of missing) {
    const amount = request.amountLabel ?? "the amount in this finding's details";
    // #4231 lens rounds 4-5: the check that prevents a second credit comes first.
    const invoice = payment.xeroInvoiceNumber ? `this booking's invoice in Xero (${payment.xeroInvoiceNumber})` : "this booking's invoice in Xero";
    const paidBack = `Refund request ${request.refundRequestId} was paid back by bank transfer (${amount}) before the booking had a Xero invoice, so its own refund credit note was never queued.`;
    const staysOpen = "The app cannot record a credit raised by hand for a request's note it never queued, so this finding stays.";
    const details = { paymentId: payment.id, refundRequestId: request.refundRequestId, refundAmountCents: request.amountCents };
    if (cancellationNote) {
      // Round 5 (F1): never "nothing more" here - a folded note beside a credit
      // raised by hand would still credit the request twice. (F2) A withdrawn
      // row never reached Xero; a queued or failed one may yet.
      const reason =
        `${paidBack} This payment may have a cancellation refund credit note, and one raised before this release may already include the request's ${amount}. Two steps, in this order. ` +
        `First, always compare the cancellation note's lines on ${invoice} with the cancellation's own refund (the booking's cancellation in the app, or its refund lines in Xero). ` +
        `If the request's ${amount} is in it, edit the note in place to the cancellation's own refund - remove its allocations and refund payments first, then record them again; never void it. ` +
        "A note Xero voided, or a create row withdrawn (CANCELLED) in Xero Operations, holds nothing; for one still queued or failed there, wait for it or check its amount in Xero Operations before raising anything by hand. " +
        `Second, check ${invoice} for a credit already raised for this request, and raise the request's own credit note by hand in Xero only if none exists yet. ${staysOpen}`;
      const action = addAction(actionMap, buildManualReviewAction(context.booking.id, reason));
      addFinding(findings, { code: "REFUND_REQUEST_NOTE_NOT_QUEUED", severity: "manual_review", summary: reason, safeToAutoApply: false, details, actionKeys: [action.key] });
      continue;
    }
    // No cancellation note at all, so nothing can be folded: a credit already raised is the whole answer.
    const opening = `First check ${invoice} for a credit already raised for this request (${amount}). If there is one, nothing more is needed: do not raise another. ${staysOpen} ${paidBack}`;
    const action = addAction(actionMap, {
      key: `queue:refund-request-credit-note:${payment.id}:${request.refundRequestId}`,
      bookingId: context.booking.id,
      type: "QUEUE_REFUND_REQUEST_CREDIT_NOTE",
      description: `Queue refund request ${request.refundRequestId}'s own Xero refund credit note (${amount}), once an officer has checked Xero holds no credit raised by hand for it.`,
      safeToAutoApply: false,
      payload: { paymentId: payment.id, refundRequestId: request.refundRequestId, refundAmountCents: request.amountCents },
    });
    addFinding(findings, {
      code: "REFUND_REQUEST_NOTE_NOT_QUEUED",
      severity: "critical",
      summary: `${opening} If no credit for the request exists yet, apply this action by its key to queue the request's own credit note.`,
      safeToAutoApply: false,
      details,
      actionKeys: [action.key],
    });
  }
}
