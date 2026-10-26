import type { ManualRefundTaskKind } from "@prisma/client";

import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";
import { exactPrefix } from "@/lib/prisma-exact-prefix";

/**
 * #4042 (`INV-PAY-124`): what marks, keys, reads and refuses a group
 * organiser's hand-back - client-safe, so the finance card, the resolution
 * door, Net Collected, "Refunds owed", the ledger census and the writer
 * (`group-organiser-hand-back.ts`) all ask it here (`INV-SSOT`). Its own module
 * rather than another section of `manual-refund-task-settlement-rules.ts`,
 * which is at its size budget.
 */

/**
 * #4042 (`INV-PAY-124`): THE OCCURRENCE-KEY PREFIX of a group organiser's
 * hand-back - the one task an organiser's cancel of a group settled by Internet
 * Banking raises, on the organiser's booking, so the treasurer repays the
 * joiners' refunds to the organiser. One per settlement: the key is the
 * duplicate fence and the marker. It IS a cancellation's hand-back, so it is
 * not in the list below; it carries no `paymentId`, because the cancel already
 * recorded each joiner's refund on the joiner's own payment.
 */
export const GROUP_ORGANISER_HAND_BACK_KEY_PREFIX = "group-organiser-hand-back:";

/**
 * The occurrence key of one group settlement's organiser hand-back
 * (`INV-PAY-124`), or, with a joiner, of the SUPPLEMENTARY task raised for a
 * share booked after the settlement's task was closed.
 */
export function groupOrganiserHandBackOccurrenceKey(settlementId: string, childBookingId?: string): string {
  return `${GROUP_ORGANISER_HAND_BACK_KEY_PREFIX}${settlementId}${childBookingId ? `:${childBookingId}` : ""}`;
}

/** Every organiser hand-back of one settlement, its supplementary tasks included, as a where fragment. */
export function groupOrganiserHandBackTasksWhere(settlementId: string) {
  const key = groupOrganiserHandBackOccurrenceKey(settlementId);
  return { OR: [{ occurrenceKey: key }, { occurrenceKey: exactPrefix(`${key}:`) }] };
}

/**
 * #4042 (`INV-PAY-124`): a group organiser's hand-back is paid, never
 * dismissed. The cancel booked the joiners' refunds as made when it raised it,
 * so dismissing it would leave the ledger saying the organiser was repaid.
 */
export const GROUP_ORGANISER_HAND_BACK_DISMISS_MESSAGE =
  "This repays a group organiser for joiners' refunds the group's cancellation has already recorded as made, so it cannot be dismissed here. Repay the organiser and mark it paid back. If the club has decided not to repay them, that changes the cancelled bookings' own figures: take it to the treasurer to correct them.";

/**
 * #4042 (`INV-PAY-124`): why a group organiser's hand-back cannot be closed as
 * asked, or null. It is never dismissed (above). Its total grows as each
 * joiner's cancel completes, so a completion must name the total the screen
 * showed, and is refused when that is no longer the total.
 */
export function groupOrganiserHandBackRefusal(
  task: { kind: ManualRefundTaskKind | string | null; occurrenceKey: string | null; amountCents: number | null },
  resolution: "completed" | "dismissed",
  confirmedAmountCents: number | null,
  format: ClubFormat,
): string | null {
  if (!isGroupOrganiserHandBackTask(task)) return null;
  if (resolution === "dismissed") return GROUP_ORGANISER_HAND_BACK_DISMISS_MESSAGE;
  if (confirmedAmountCents === null) {
    return "This repayment's total grows as each joiner's place is cancelled, so it is marked paid back at the total the screen shows. Refresh the page and try again.";
  }
  if (task.amountCents !== null && confirmedAmountCents !== task.amountCents) {
    return `Another joiner's share was added; the organiser is now owed ${formatCents(task.amountCents, format)}. Repay the difference, then mark it paid back.`;
  }
  return null;
}

/**
 * #4042 (`INV-PAY-124`): the joiners' shares a group organiser's hand-back
 * holds, kept on the row (`reviewContext.groupOrganiserHandBack`) so its total
 * and its reason are built from data, never parsed back out of prose.
 */
export type GroupOrganiserHandBackShares = {
  settlementId: string;
  shares: Array<{ bookingId: string; name: string; cents: number }>;
  /** When its "Manual refund needed" alert went out (ISO): it is never sent again. */
  alertSentAt?: string;
  /** When a run claimed the right to send it (ISO): a lease no other run sends under until it expires. */
  alertClaimedAt?: string;
  /** How many sends reached nobody; at `GROUP_HAND_BACK_ALERT_MAX_UNDELIVERED` no run sends again. */
  alertUndeliveredCount?: number;
};

/** #4042: after this many sends that reached nobody, the alert stops; the task on the queue stays the record. */
export const GROUP_HAND_BACK_ALERT_MAX_UNDELIVERED = 3;

/** The shares a group organiser's hand-back recorded, or null for any other row. */
export function readGroupOrganiserHandBackShares(reviewContext: unknown): GroupOrganiserHandBackShares | null {
  if (!reviewContext || typeof reviewContext !== "object" || Array.isArray(reviewContext)) return null;
  const value = (reviewContext as Record<string, unknown>).groupOrganiserHandBack;
  if (!value || typeof value !== "object") return null;
  const { settlementId, shares, alertSentAt, alertClaimedAt, alertUndeliveredCount } = value as Record<string, unknown>;
  if (typeof settlementId !== "string" || !Array.isArray(shares)) return null;
  const parsed = shares.flatMap((share: unknown) => {
    const { bookingId, name, cents } = (share ?? {}) as Record<string, unknown>;
    return typeof bookingId === "string" && typeof name === "string" && Number.isInteger(cents) && (cents as number) > 0
      ? [{ bookingId, name, cents: cents as number }]
      : [];
  });
  return {
    settlementId,
    shares: parsed,
    ...(typeof alertSentAt === "string" ? { alertSentAt } : {}),
    ...(typeof alertClaimedAt === "string" ? { alertClaimedAt } : {}),
    ...(Number.isInteger(alertUndeliveredCount) && (alertUndeliveredCount as number) > 0 ? { alertUndeliveredCount: alertUndeliveredCount as number } : {}),
  };
}

/**
 * #4042 (`INV-PAY-124`): THE one definition of a group organiser's hand-back -
 * the kind and the key prefix - as a where fragment for a query and, below, as
 * the predicate for a row (`INV-SSOT`). A cancellation's hand-back, so a read
 * by this fragment needs no `NOT_NON_CANCELLATION_HAND_BACK_WHERE`: its prefix
 * is none of the non-cancellation prefixes. A read that ALSO names the kind
 * literally is policed by `edit-refund-hand-back-readers-census.test.ts`.
 */
export const GROUP_ORGANISER_HAND_BACK_WHERE = {
  kind: "CANCELLED_BOOKING_HAND_BACK" satisfies ManualRefundTaskKind,
  occurrenceKey: { startsWith: GROUP_ORGANISER_HAND_BACK_KEY_PREFIX },
} as const;

/** #4042: is this task a group organiser's hand-back (`INV-PAY-124`)? The fragment above, for a row. */
export function isGroupOrganiserHandBackTask(task: {
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
}): boolean {
  return (
    task.kind === GROUP_ORGANISER_HAND_BACK_WHERE.kind &&
    (task.occurrenceKey?.startsWith(GROUP_ORGANISER_HAND_BACK_WHERE.occurrenceKey.startsWith) ?? false)
  );
}
