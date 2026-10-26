/**
 * #4117 (`INV-PAY-128`): what is said about an approved appeal's card refund
 * that was not made in full - on the screen, in the approval's toast and in the
 * officers' alert. One home, so the three say the same thing. Never on the
 * request's admin notes, which the member reads. Plain module: the client page
 * imports it.
 *
 * The part not made splits in two, because a bank transfer for the second
 * could pay the member twice:
 *
 * - refused: Stripe answered `failed` or `canceled`, so it certainly did not
 *   go back;
 * - unanswered: Stripe gave no answer (a timeout, or the app failed to record
 *   what Stripe did), so it may have been made.
 */

/** Where an approved appeal's card refund stands (`readApprovedAppealOutcomes`). */
export type AppealCardRefundState = "made" | "retrying" | "dead" | "not_queued"

/** What an approved appeal has still to give back, as the screen reads it (`readApprovedAppealOutcomes`). */
export interface ApprovedAppealOutcome {
  cardRefundState: AppealCardRefundState
  /** Not yet given back by card. */
  cardRefundOwedCents: number
  /** When not queued: of that, refused by Stripe (certainly not made) and unanswered (it may have been made). */
  cardRefundRefusedCents: number
  cardRefundUnansweredCents: number
  /** Promised back by bank transfer, its task still open. */
  handBackOwedCents: number
  /** Promised back by bank transfer, its task dismissed: the club kept it. */
  handBackDismissedCents: number
  /** #4120: its card refund closed as paid another way in part - the part not paid back. */
  cardRefundClosedUnpaidCents: number
}

/** The part of an approved appeal's card refund not made, split by what is known. */
export interface UnmadeCardRefund {
  refusedCents: number
  unansweredCents: number
}

/** One instruction per part: refund the refused part another way; check Stripe before refunding the other. */
export function unmadeCardRefundInstructions(unmade: UnmadeCardRefund, formatAmount: (cents: number) => string): string {
  const parts: string[] = []
  if (unmade.refusedCents > 0) {
    parts.push(`${formatAmount(unmade.refusedCents)} was refused by Stripe, so it certainly did not go back: refund it another way.`)
  }
  if (unmade.unansweredCents > 0) {
    parts.push(
      `${formatAmount(unmade.unansweredCents)} got no answer from Stripe and may have been made: check the payment in Stripe before refunding it another way.`,
    )
  }
  return parts.join(" ")
}

/** The officers' alert, and the screen's line, when no retry could be queued. */
export function cardRefundNotQueuedMessage(unmade: UnmadeCardRefund, formatAmount: (cents: number) => string): string {
  return `This card refund could not be queued for retry. ${unmadeCardRefundInstructions(unmade, formatAmount)}`
}

/** The toast after an approval: "processed" only when the card refund was made in full. */
export function refundAppealApprovedNotice(
  answer: { cardRefundOwedCents: number; cardRefundQueued: boolean } & UnmadeCardRefund,
  formatAmount: (cents: number) => string,
): string {
  if (answer.cardRefundOwedCents <= 0) return "Refund approved and processed"
  if (answer.cardRefundQueued) return `Refund approved; ${formatAmount(answer.cardRefundOwedCents)} is queued for retry`
  return `Refund approved, but its card refund could not be queued for retry. ${unmadeCardRefundInstructions(answer, formatAmount)}`
}

/**
 * What an approved appeal has refunded so far: the approved amount less every
 * part of its outcome (`readApprovedAppealOutcomes`) that has not gone back -
 * by card (queued, dead, not queued, or closed as paid another way for less)
 * and by bank transfer while this request's own task is open or once it is
 * dismissed. The one sum, read by
 * the screen's "Refunded" and by the booking-ledger census's
 * `REFUND_APPEAL_PAID` (#4120).
 */
export function approvedAppealRefundedCents(approvedAmountCents: number, outcome: Partial<ApprovedAppealOutcome>): number {
  const stillOwedCents =
    (outcome.cardRefundOwedCents ?? 0) + (outcome.handBackOwedCents ?? 0) + (outcome.handBackDismissedCents ?? 0) + (outcome.cardRefundClosedUnpaidCents ?? 0)
  return Math.max(0, approvedAmountCents - Math.max(0, stillOwedCents))
}

/** An approved appeal's outstanding parts, as the screen lists them under "Refunded" (`readApprovedAppealOutcomes`). */
export function refundAppealOutstandingLines(
  outcome: Partial<ApprovedAppealOutcome>,
  formatAmount: (cents: number) => string,
): string[] {
  const lines: string[] = []
  const owed = outcome.cardRefundOwedCents ?? 0
  if (owed > 0 && outcome.cardRefundState === "retrying") lines.push(`${formatAmount(owed)} of the card refund is queued for retry.`)
  if (owed > 0 && outcome.cardRefundState === "dead") lines.push(`${formatAmount(owed)} of the card refund is still owed: its retries ran out.`)
  if (owed > 0 && outcome.cardRefundState === "not_queued") {
    lines.push(
      `${cardRefundNotQueuedMessage(
        { refusedCents: outcome.cardRefundRefusedCents ?? 0, unansweredCents: outcome.cardRefundUnansweredCents ?? 0 },
        formatAmount,
      )} A refund made another way does not show here: check and record it.`,
    )
  }
  if ((outcome.handBackOwedCents ?? 0) > 0) lines.push(`${formatAmount(outcome.handBackOwedCents ?? 0)} is still to be refunded by bank transfer.`)
  if ((outcome.cardRefundClosedUnpaidCents ?? 0) > 0) {
    lines.push(`${formatAmount(outcome.cardRefundClosedUnpaidCents ?? 0)} of the card refund was closed without being paid back.`)
  }
  if ((outcome.handBackDismissedCents ?? 0) > 0) {
    lines.push(`${formatAmount(outcome.handBackDismissedCents ?? 0)} was not refunded: its bank-transfer task was dismissed.`)
  }
  return lines
}

/**
 * #4124 (`INV-PAY-118`): why an appeal's ceiling is lower than the payment's
 * refundable cash - a card refund on the payment not yet made (being retried
 * after a refusal or a later failure, or stopped and listed on Stuck states for
 * "Paid another way"), which the ceiling nets so the money is not promised
 * twice (`refundAppealCeilingParts`). To the officer under "Max refundable",
 * and to the booking's owner in the appeal form. The owner is not told "to your
 * card": a stopped one may be paid back another way.
 */
export function appealCardRefundOwedOfficerNote(amount: string): string {
  return `Less ${amount} of card refund not yet made for this payment (retrying, or stopped and listed on Stuck states).`
}

/** The owner's line, beside the form's maximum; `ceilingIsZero` when that refund is everything still refundable. */
export function appealCardRefundOwedMemberNote(amount: string, ceilingIsZero: boolean): string {
  return ceilingIsZero
    ? `${amount} is still owed back to you, so there is nothing more to appeal for while that refund is outstanding.`
    : `${amount} is still owed back to you, so it is not part of this maximum.`
}
