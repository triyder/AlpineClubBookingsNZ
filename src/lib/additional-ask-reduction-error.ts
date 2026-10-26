/**
 * #3954 (review round 4): THE ONE REFUSAL A PRICE REDUCTION RAISES WHEN THE
 * UNPAID ASK IT READ MOVED UNDER IT - the member's capture landed, or a retry
 * claimed the ask's failed mint - before the edit could retire it.
 *
 * TRANSIENT, AND TYPED SO NOBODY READS IT AS FINAL. Every door answers it with
 * a 409 and the edit rolls back whole; trying again a moment later reads the
 * ask as it now stands. A member-guest consent decline or expiry must not turn
 * it into a terminal BLOCKED row (`consentRemovalRefusalMessage` lets it
 * propagate, so the claim rolls back to PENDING and the sweep or the member
 * retries). A leaf module - only `ApiError` - so a route or the consent service
 * can recognise it without pulling the reduction's payment graph in.
 */
import { ApiError } from "@/lib/api-error";

/** The member's capture, or a retry's claim, landed while the reduction was saved. */
export const ADDITIONAL_ASK_CHANGED_DURING_REDUCTION_MESSAGE =
  "A payment on this booking changed while this was being saved, so nothing was changed. Please try again in a moment.";

/**
 * A retry is minting the booking's card request at this moment (claimed within
 * `RECENT_RECOVERY_CLAIM_MS`); closing it under the retry would leave its old
 * figure live beside the smaller ask. It finishes within seconds.
 */
export const ADDITIONAL_ASK_BEING_RAISED_MESSAGE =
  "A payment request on this booking is being set up right now, so nothing was changed. Please try again in a moment.";

/**
 * Round 6: the consent route's answer to the same race. The member there is
 * answering a guest invitation, not saving a change, so the reduction doors'
 * wording ("nothing was changed") is not theirs.
 */
export const CONSENT_ANSWER_RACED_MESSAGE =
  "We couldn't record your answer because something changed on this booking. Please try again in a moment.";

export class AdditionalAskChangedDuringReductionError extends ApiError {
  constructor(
    message: string = ADDITIONAL_ASK_CHANGED_DURING_REDUCTION_MESSAGE,
    /** Round 7: the database error a deadlock or write conflict surfaced as, kept for the logs. */
    options?: { cause?: unknown },
  ) {
    super(message, 409);
    this.name = "AdditionalAskChangedDuringReductionError";
    if (options && "cause" in options) this.cause = options.cause;
  }
}

/**
 * #3954 review round 6: a deadlock, or Postgres aborting the edit's write for
 * a conflict, while the reduction retires the ask is the same transient race
 * as a fence that matched nothing - the webhook or the recovery runner wrote
 * the same rows in another order. Answered as the 409 "try again", never a 500.
 * Prisma reports it as `P2034`; through the driver adapter the database's own
 * `40P01` can surface instead.
 */
export function isWriteConflictOrDeadlock(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "P2034" || code === "40P01") return true;
  const message = err instanceof Error ? err.message : "";
  return message.includes("40P01") || message.includes("deadlock detected");
}
