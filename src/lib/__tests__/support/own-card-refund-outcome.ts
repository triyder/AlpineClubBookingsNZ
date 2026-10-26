/**
 * #4070: the answers an own-card edit refund can get from
 * `refundPaymentTransactions` after the edit commits, and what the "Booking
 * Modified" email must then say. Shared by the four edit doors' tests so each
 * door is driven through the same states, and (#4084) by the cancel's, whose
 * "Booking Cancelled" email says `card` for `own` and `card_pending` for
 * `own_card_pending`. `queued` is what still owed goes to the recovery runner
 * (`enqueueBookingModificationRefundRecovery`): a call that throws queues the
 * unpaid remainder, and (#4083, `INV-PAY-128`) a refund Stripe answered
 * `failed` or `canceled` queues exactly the slices it refused, as their plan,
 * already moved to their next key. The cancel queues
 * nothing new for either: its pre-persisted debt is left open.
 *
 * `primeOwnCardRefund` answers a `refundPaymentTransactions` double with the
 * state's refunds, or rejects with its error; `expectQueuedOnce` asserts what
 * the door queued.
 */
import { expect, type Mock } from "vitest";

import type { BookingModifiedRefundDestination } from "@/lib/booking-modified-email-copy";
import type { RefundAllocationSlice } from "@/lib/payment-transactions";

type Refund = {
  refundId: string;
  paymentIntentId: string;
  amountCents: number;
  status: string | null;
  slice: RefundAllocationSlice;
};
type Answer = { refunds: Refund[] } | Error;

/** Nothing queued, the whole unpaid remainder, or exactly the refused slices. */
type Queued = null | "remainder" | { refused: RefundAllocationSlice[] };

const NEWER_SLICE: RefundAllocationSlice = { paymentTransactionId: "txn_additional", amountCents: 600 };
const OLDER_SLICE: RefundAllocationSlice = { paymentTransactionId: "txn_primary", amountCents: 400 };

const refundOf = (slice: RefundAllocationSlice, status: string | null, refundId = "re_own_1"): Refund => ({
  refundId,
  paymentIntentId: "pi_original",
  amountCents: slice.amountCents,
  status,
  slice,
});

const made = (status: string | null): Answer => ({ refunds: [refundOf(NEWER_SLICE, status)] });

export const OWN_CARD_REFUND_STATES: ReadonlyArray<{
  label: string;
  answer: Answer;
  queued: Queued;
  destination: BookingModifiedRefundDestination;
}> = [
  { label: "Stripe answered succeeded", answer: made("succeeded"), queued: null, destination: "own" },
  { label: "Stripe answered pending", answer: made("pending"), queued: null, destination: "own" },
  // A refund with no status counts as made, as the organiser executor counts it (`status ?? "unknown"`).
  { label: "Stripe answered no status", answer: made(null), queued: null, destination: "own" },
  { label: "the Stripe call throws", answer: new Error("stripe down"), queued: "remainder", destination: "own_card_pending" },
  { label: "Stripe answered failed", answer: made("failed"), queued: { refused: [NEWER_SLICE] }, destination: "own_card_pending" },
  { label: "Stripe answered canceled", answer: made("canceled"), queued: { refused: [NEWER_SLICE] }, destination: "own_card_pending" },
  {
    label: "one slice made, one refused",
    answer: { refunds: [refundOf(NEWER_SLICE, "succeeded"), refundOf(OLDER_SLICE, "failed", "re_own_2")] },
    queued: { refused: [OLDER_SLICE] },
    destination: "own_card_pending",
  },
  { label: "no refund came back", answer: { refunds: [] }, queued: null, destination: "own_card_pending" },
];

export function primeOwnCardRefund(refundPaymentTransactions: Mock, answer: Answer): void {
  if (answer instanceof Error) refundPaymentTransactions.mockRejectedValue(answer);
  else refundPaymentTransactions.mockResolvedValue(answer);
}

/**
 * The door queued what the state owes, once, in integer cents: the remainder
 * of `pendingCents`, or exactly the refused slices as the row's plan.
 */
export function expectQueuedOnce(enqueue: Mock, queued: Queued, pendingCents: number): void {
  if (queued === null) {
    expect(enqueue).not.toHaveBeenCalled();
    return;
  }
  expect(enqueue).toHaveBeenCalledTimes(1);
  if (queued === "remainder") {
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ amountCents: pendingCents }));
    expect(enqueue.mock.calls[0]?.[0]).not.toHaveProperty("allocationPlan", expect.anything());
    return;
  }
  // #4083 review: each was read refused at the door, so it is queued already on
  // its next key (`refused1`) - the runner's first attempt asks Stripe afresh.
  const refusedCents = queued.refused.reduce((sum, slice) => sum + slice.amountCents, 0);
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      amountCents: refusedCents,
      allocationPlan: queued.refused.map((slice) => ({ ...slice, stripeKeySuffix: "refused1" })),
    }),
  );
}
