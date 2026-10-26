import type { ManualRefundTaskKind } from "@prisma/client";

import { CANCEL_CARD_SHORTFALL_KEY_PREFIX, isCancelCardShortfallTask } from "@/lib/manual-refund-task-settlement-rules";

/**
 * #4154 (`INV-PAY-135`): THE OCCURRENCE KEY of a capacity race's card refund
 * shortfall task, and the one reader of the race's intent from it.
 *
 * It is #4097's card refund shortfall part to CHECK - under
 * `CANCEL_CARD_SHORTFALL_KEY_PREFIX` and ending `:check`, so every reader of
 * that task (its completion, the booking ledger's line, the Xero cash
 * evidence, the census, the booking page) takes it as one - and it names the
 * card charge the race refunded, because its completion may record money only
 * on that charge (`cardShortfallSettlement`). An empty plan leaves no recovery
 * row to name it, so the key is the one place it is kept.
 *
 * One per booking in practice: a booking is cancelled once, and a later intent
 * finds it cancelled, never in the race.
 *
 * Pure, with a type-only Prisma import: the queue's payload reads it.
 */
const CAPACITY_RACE_INFIX = ":capacity-race:";
const CHECK_SUFFIX = ":check";

export function capacityRaceShortfallOccurrenceKey(bookingId: string, paymentIntentId: string): string {
  return `${CANCEL_CARD_SHORTFALL_KEY_PREFIX}${bookingId}${CAPACITY_RACE_INFIX}${paymentIntentId}${CHECK_SUFFIX}`;
}

/** The race's card intent, for a capacity race's shortfall task on its own booking; null for any other task. */
export function capacityRaceShortfallIntentId(task: {
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
  bookingId: string;
}): string | null {
  const key = task.occurrenceKey;
  const lead = `${CANCEL_CARD_SHORTFALL_KEY_PREFIX}${task.bookingId}${CAPACITY_RACE_INFIX}`;
  if (!key || !isCancelCardShortfallTask(task) || !key.startsWith(lead) || !key.endsWith(CHECK_SUFFIX)) return null;
  const intent = key.slice(lead.length, key.length - CHECK_SUFFIX.length);
  return intent.length > 0 ? intent : null;
}
