/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): what a "bank refund
 * to re-confirm" carries and says - the open hand-back the nightly undo of a
 * voided bank-transfer refund note raises (`bank-refund-void-follow-up.ts`).
 *
 * A pure leaf with no server dependency, so the refund list's card, the
 * completion route and the writer read one shape and one sentence
 * (`INV-SSOT-001`).
 */

/** The `ManualRefundTask.reviewContext` key the follow-up keeps its facts under (beside no other kind's). */
export const BANK_REFUND_VOID_FOLLOW_UP_CONTEXT_KEY = "bankRefundVoidFollowUp";

/** What the follow-up records about the void that raised it, written once at the undo. */
export interface BankRefundVoidFollowUpContext {
  /** The voided Xero credit note. */
  voidedCreditNoteId: string;
  voidedCreditNoteNumber: string | null;
  /** When the app recorded the void (the link's last write), as an ISO instant. */
  voidedAt: string;
  /** The completed hand-back whose refund the note recorded. */
  originalTaskId: string;
  /** That hand-back's `BANK_REFUND` line, which the undo reversed. */
  reversedLineId: string;
}

/** The context as the task stores it. */
export function bankRefundVoidFollowUpReviewContext(
  context: BankRefundVoidFollowUpContext,
): Record<typeof BANK_REFUND_VOID_FOLLOW_UP_CONTEXT_KEY, Record<string, string | null>> {
  return { [BANK_REFUND_VOID_FOLLOW_UP_CONTEXT_KEY]: { ...context } };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The context a follow-up keeps, or null when the column holds no readable one. */
export function readBankRefundVoidFollowUpContext(reviewContext: unknown): BankRefundVoidFollowUpContext | null {
  if (!reviewContext || typeof reviewContext !== "object" || Array.isArray(reviewContext)) return null;
  const raw = (reviewContext as Record<string, unknown>)[BANK_REFUND_VOID_FOLLOW_UP_CONTEXT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const voidedCreditNoteId = readString(record.voidedCreditNoteId);
  const voidedAt = readString(record.voidedAt);
  const originalTaskId = readString(record.originalTaskId);
  const reversedLineId = readString(record.reversedLineId);
  if (!voidedCreditNoteId || !voidedAt || !originalTaskId || !reversedLineId) return null;
  return {
    voidedCreditNoteId,
    voidedCreditNoteNumber: readString(record.voidedCreditNoteNumber),
    voidedAt,
    originalTaskId,
    reversedLineId,
  };
}

/**
 * The two answers that complete a follow-up (the money went to the member).
 * "Not yet" leaves it on the list, and "the club keeps it" is the ordinary
 * dismissal with a reason, so neither is an answer here.
 */
export const BANK_REFUND_VOID_ANSWERS = ["fresh-note", "recorded-in-xero"] as const;
export type BankRefundVoidAnswer = (typeof BANK_REFUND_VOID_ANSWERS)[number];

/** The longest credit-note number the "already in Xero" answer accepts (Xero's own limit is 255). */
export const HAND_MADE_CREDIT_NOTE_NUMBER_MAX = 255;

/** #4421: the one example credit-note number every hand-made-note prompt, placeholder and message shows. */
export const EXAMPLE_CREDIT_NOTE_NUMBER = "CN-0123";

/**
 * #4421 (`INV-SSOT`, `INV-INT-028`): THE refusal of a hand-made note that a
 * create row or link here already records - one note, one refund. Shared by
 * the #4162 answer (`recordHandMadeRefundNoteLink`) and "Resolve by hand"
 * (`claimResolveRecordingRefundNote`), so both say it the same way.
 */
export function handMadeNoteAlreadyRecordedMessage(creditNoteNumber: string): string {
  return `Credit note ${creditNoteNumber} is already recorded against another refund or booking here, so it cannot also record this one. Check the number, or make a separate credit note in Xero for this refund.`;
}

/** The one question the refund list asks of a follow-up. Takes formatted parts. */
export function bankRefundVoidQuestion(parts: {
  bookingReference: string;
  amount: string;
  memberName: string;
  creditNoteNumber: string | null;
  voidedOn: string;
}): string {
  const note = parts.creditNoteNumber ? `Its Xero credit note ${parts.creditNoteNumber}` : "Its Xero credit note";
  return `Booking ${parts.bookingReference}: ${parts.amount} to ${parts.memberName}. ${note} was found voided on ${parts.voidedOn}, so it's back on this list. Has the ${parts.amount} gone to the member?`;
}

/** Each answer as the dialog offers it. */
export const BANK_REFUND_VOID_ANSWER_COPY: Record<BankRefundVoidAnswer, { label: string; help: string }> = {
  "fresh-note": {
    label: "Yes, raise a fresh credit note",
    help: "The member was paid. The refund is recorded again and one new credit note is raised in Xero, dated today.",
  },
  "recorded-in-xero": {
    label: "Yes, I already recorded it in Xero myself",
    help: "The member was paid and you made the credit note in Xero by hand. Type its number: the app checks Xero has it, live, for this amount, and tracks it from now on.",
  },
};

/** The refusal when a follow-up is completed without one of the two answers (an older screen). */
export const BANK_REFUND_VOID_ANSWER_REQUIRED_MESSAGE =
  "This refund is back on the list because its Xero credit note was voided. Say whether to raise a fresh credit note or which note you made in Xero by hand - refresh the page and answer the question.";

/** The refusal when an answer is sent for a task that is not a follow-up. */
export const BANK_REFUND_VOID_ANSWER_NOT_ASKED_MESSAGE =
  "This refund was not put back on the list by a voided credit note, so that answer does not apply. Refresh the page and try again.";

/** What the treasurer is told once a follow-up is completed on one of its answers. */
export function bankRefundVoidCompletionMessage(answer: BankRefundVoidAnswer, creditNoteNumber?: string | null): string {
  return answer === "fresh-note"
    ? "Refund recorded as paid back again. One fresh credit note is queued for Xero, dated today."
    : `Refund recorded as paid back again, against credit note ${creditNoteNumber ?? "the one you made"} in Xero, which the app now tracks.`;
}

// #4421 (`INV-INT-028`, `INV-SSOT`): what "Resolve by hand" on the Xero
// operations panel says and accepts for a refund credit note, here beside the
// #4162 answer's hand-made-note words (one client-safe home the resolve
// route's schema, the resolve module and the panel's dialogs all read).

/** The refusal when a refund credit note is resolved without the number of the note made in Xero. */
export const RESOLVE_NOTE_NUMBER_REQUIRED_MESSAGE = `This is a refund credit note. Type the number of the credit note you made in Xero (for example ${EXAMPLE_CREDIT_NOTE_NUMBER}), so the app can check it and record which note it is.`;

/**
 * The refusal of a refund credit note whose amount the app cannot read: no
 * note can be checked against it, and Retry refuses it too. Mark
 * non-replayable stops anything re-running it (it does not take it off the
 * failure list), and the treasurer decides what Xero needs (review: money F2,
 * security F5).
 */
export const RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE =
  "The app cannot read this refund credit note's amount, so it cannot check a credit note made in Xero against it, and it cannot retry it either. Use Mark non-replayable on it, and ask the treasurer what this refund needs in Xero. Don't also make a credit note by hand.";

/**
 * The refusal of a FAILED refund credit note a later run already raised
 * (review round 2: a retry, or another run of the same note, SUCCEEDED or
 * PARTIAL): the note it made stands for the refund, so no hand-made one may
 * be recorded beside it.
 */
export const RESOLVE_NOTE_SUPERSEDED_MESSAGE =
  "A later run of this refund credit note already made its note in Xero, so this job needs no credit note made by hand and is not resolved here. If you made one by hand as well, don't record it: ask the treasurer whether to void it. If that earlier note was later voided in Xero, follow the voided-note task on the treasurer's refund list instead.";

/**
 * The refusal of a part-done (PARTIAL) refund credit note that names no note
 * (review round 2): the app cannot tell which note records the refund, so it
 * neither asks for one nor resolves it as if covered.
 */
export const RESOLVE_NOTE_PARTIAL_NO_NOTE_MESSAGE =
  "This refund credit note is part-done but names no credit note, so the app cannot tell which note records the refund. Retry it, or ask the treasurer. Don't make a credit note by hand for it.";

/** What the officer is told when a retry ran beside the resolve and the note it recorded could not be taken back (review round 2). */
export const RESOLVE_NOTE_WITHDRAW_FAILED_MESSAGE =
  "A retry of this refund credit note is running, and the app could not take back the credit note it had just recorded. An alert has been raised. Check Xero and ask the treasurer before doing anything else with this refund.";

/** The refusal of a note number sent for a row that takes none (review: money F5). */
export const RESOLVE_NOTE_NOT_ASKED_MESSAGE =
  "This job already names its credit note, or doesn't take a credit note number. Reload it and check before resolving.";

/** The refusal when a retry of the job ran or is running beside the resolve (review: concurrency F1). */
export const RESOLVE_NOTE_RETRY_RAN_MESSAGE =
  "A retry of this refund credit note ran while you were resolving it, and it may have made a credit note in Xero. Nothing was recorded. Wait for the retry to finish and check Xero before resolving again.";

/** What a second officer is told when the job was resolved first by someone else (review: concurrency F6). */
export function alreadyResolvedWithNoteMessage(recordedNumber: string | null): string {
  return recordedNumber
    ? `This refund credit note was already resolved, recording credit note ${recordedNumber}. Check Xero: if that is not the note for this refund, ask the treasurer.`
    : "This refund credit note was already resolved, with no credit note number recorded. Check Xero and ask the treasurer before making any other note for it.";
}
