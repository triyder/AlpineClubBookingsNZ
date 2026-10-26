// #4117 (`INV-PAY-128`): what an approved refund appeal has still to give back,
// as the refund-requests screen reads it - so "Refunded" is what went back.
import { describe, expect, it, vi } from "vitest";

import { readApprovedAppealOutcomes } from "@/lib/refund-appeal-outcome";
import { approvedAppealRefundedCents, refundAppealOutstandingLines } from "@/lib/refund-request-card-refund-copy";
import { cardRefundPaidAnotherWayOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";

const AT = new Date("2026-06-20T00:00:05.000Z");
const MADE_AT = new Date("2026-06-20T00:00:01.000Z");

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: "op-1",
    type: "REFUND_BOOKING_MODIFICATION",
    status: "PENDING",
    attempts: 0,
    nextRetryAt: AT,
    idempotencyKey: "refund_request_refund_rq-1",
    amountCents: 2_500,
    allocationPlan: [
      { paymentTransactionId: "txn-new", amountCents: 1_500, madeRefundId: "re_made" },
      { paymentTransactionId: "txn-old", amountCents: 1_000, stripeKeySuffix: "refused1" },
    ],
    paymentTransactionId: null,
    createdAt: AT,
    succeededAt: null,
    ...overrides,
  };
}

function db({
  operations = [operation()],
  refundedAmountCents = 1_500,
  audits = [] as Array<{ entityId: string; metadata: unknown }>,
  tasks = [] as Array<{ occurrenceKey: string; status?: string; amountCents: number | null; raisedAmountCents?: number | null }>,
  refunds = [
    { stripeRefundId: "re_made", paymentTransactionId: "txn-new", amountCents: 1_500, status: "succeeded", createdAt: MADE_AT, stripeCreatedAt: MADE_AT },
  ] as Array<Record<string, unknown>>,
} = {}) {
  return {
    payment: {
      findMany: vi.fn(async () => [
        {
          id: "p-1",
          status: "PARTIALLY_REFUNDED",
          amountCents: 10_000,
          refundedAmountCents,
          recoveryOperations: operations,
          refunds,
        },
      ]),
    },
    auditLog: { findMany: vi.fn(async () => audits) },
    manualRefundTask: { findMany: vi.fn(async () => tasks.map((task) => ({ status: "OPEN", ...task }))) },
  };
}

const approved = { id: "rq-1", status: "APPROVED", booking: { payment: { id: "p-1" } } };

async function outcomeOf(store: ReturnType<typeof db>) {
  return (await readApprovedAppealOutcomes(store as never, [approved])).get("rq-1");
}

describe("an approved appeal's card refund, read from its recovery row", () => {
  it("retrying: the made slice is filled by its own refund; only the refused part is owed", async () => {
    expect(await outcomeOf(db())).toMatchObject({ cardRefundState: "retrying", cardRefundOwedCents: 1_000, handBackOwedCents: 0 });
  });

  it("dead (retries spent): still owed, not queued for retry", async () => {
    expect(await outcomeOf(db({ operations: [operation({ status: "FAILED", attempts: 5, nextRetryAt: null })] }))).toMatchObject({
      cardRefundState: "dead",
      cardRefundOwedCents: 1_000,
    });
  });

  it("capped per payment, as Refunds owed is: never more than the payment still holds", async () => {
    expect(await outcomeOf(db({ refundedAmountCents: 9_600 }))).toMatchObject({ cardRefundState: "retrying", cardRefundOwedCents: 400 });
  });

  it("closed: made, nothing owed", async () => {
    expect(await outcomeOf(db({ operations: [operation({ status: "SUCCEEDED", succeededAt: new Date("2026-06-21T00:00:00.000Z") })] }))).toMatchObject({
      cardRefundState: "made",
      cardRefundOwedCents: 0,
    });
  });
});

describe("#4120: an appeal's card refund closed as paid another way (card-refund-paid-another-way.ts)", () => {
  // The close moves the row to SUCCEEDED and writes a COMPLETED task for what was paid back,
  // `raisedAmountCents` keeping what was still owed when it closed.
  const closed = operation({ status: "SUCCEEDED", succeededAt: new Date("2026-06-21T00:00:00.000Z") });
  const close = (op: string, paid: number, owed: number, xeroRefundNote: "now" | "none" = "now") => ({
    occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey(op, { xeroRefundNote }),
    status: "COMPLETED",
    amountCents: paid,
    raisedAmountCents: owed,
  });

  it("closed in full: nothing unpaid, the whole approved amount refunded", async () => {
    const outcome = await outcomeOf(db({ operations: [closed], tasks: [close("op-1", 1_000, 1_000)] }));
    expect(outcome).toMatchObject({ cardRefundState: "made", cardRefundOwedCents: 0, cardRefundClosedUnpaidCents: 0 });
    expect(approvedAppealRefundedCents(2_500, outcome ?? {})).toBe(2_500);
  });

  it("closed in part: the part not paid back is not refunded, and the screen says so", async () => {
    const store = db({ operations: [closed], tasks: [close("op-1", 600, 1_000, "none"), close("op-other", 0, 900)] });
    const outcome = await outcomeOf(store);
    expect(outcome).toMatchObject({ cardRefundState: "made", cardRefundOwedCents: 0, cardRefundClosedUnpaidCents: 400 });
    expect(approvedAppealRefundedCents(2_500, outcome ?? {})).toBe(2_100);
    expect(refundAppealOutstandingLines(outcome ?? {}, (cents) => `$${cents / 100}`)).toEqual(["$4 of the card refund was closed without being paid back."]);
    expect(store.manualRefundTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "COMPLETED", occurrenceKey: { in: expect.arrayContaining([close("op-1", 0, 0).occurrenceKey]) } }) }),
    );
  });

  it("paid twice: a card refund Stripe made before the part close and recorded after it went back too, so it is not unpaid", async () => {
    // Two refused slices, $6 and $4, dead and closed with $2 paid back: $8 unpaid. Stripe's lost
    // refund of the $4 slice - made before the close, recorded after it - then arrives.
    const twoSlices = operation({
      status: "SUCCEEDED",
      succeededAt: new Date("2026-06-21T00:00:00.000Z"),
      amountCents: 1_000,
      allocationPlan: [
        { paymentTransactionId: "txn-a", amountCents: 600, stripeKeySuffix: "refused1" },
        { paymentTransactionId: "txn-b", amountCents: 400, stripeKeySuffix: "refused1" },
      ],
    });
    const late = (paymentTransactionId: string, amountCents: number) => ({
      stripeRefundId: `re_late_${paymentTransactionId}`,
      paymentTransactionId,
      amountCents,
      status: "succeeded",
      createdAt: new Date("2026-06-22T00:00:00.000Z"),
      stripeCreatedAt: new Date("2026-06-20T00:00:06.000Z"),
    });
    const read = (refunds: Array<Record<string, unknown>>) => outcomeOf(db({ operations: [twoSlices], tasks: [close("op-1", 200, 1_000)], refunds }));
    expect(await read([])).toMatchObject({ cardRefundClosedUnpaidCents: 800 });
    expect(await read([late("txn-b", 400)])).toMatchObject({ cardRefundClosedUnpaidCents: 400 });
    // Never below nothing: Stripe sent both slices, more than the close left unpaid.
    expect(await read([late("txn-a", 600), late("txn-b", 400)])).toMatchObject({ cardRefundClosedUnpaidCents: 0 });
  });

  it("a row still owed is never read as closed", async () => {
    const outcome = await outcomeOf(db({ tasks: [close("op-1", 600, 1_000)] }));
    expect(outcome).toMatchObject({ cardRefundState: "retrying", cardRefundClosedUnpaidCents: 0 });
  });
});

describe("#4120: an appeal refunded to the group organiser's card (#3956)", () => {
  // Its debt hangs on the joiner's own payment under the appeal's own key, its
  // plan naming the key rather than a transaction (`organiserChildRefundAllocationPlan`).
  const debt = (status: string) =>
    operation({
      idempotencyKey: "organiser_card_appeal_refund_rq-1",
      amountCents: 4_000,
      status,
      allocationPlan: [{ paymentTransactionId: "organiser_card_appeal_refund_rq-1", amountCents: 4_000 }],
    });

  it("still to be made: the whole debt is owed, so the screen and the census never read it as refunded", async () => {
    const outcome = await outcomeOf(db({ operations: [debt("PENDING")], refundedAmountCents: 5_000, refunds: [] }));
    expect(outcome).toMatchObject({ cardRefundState: "retrying", cardRefundOwedCents: 4_000 });
    expect(approvedAppealRefundedCents(4_000, outcome ?? {})).toBe(0);
  });

  it("made (the debt closed): nothing owed, all of it refunded", async () => {
    const outcome = await outcomeOf(db({ operations: [debt("SUCCEEDED")], refundedAmountCents: 5_000, refunds: [] }));
    expect(outcome).toMatchObject({ cardRefundState: "made", cardRefundOwedCents: 0 });
    expect(approvedAppealRefundedCents(4_000, outcome ?? {})).toBe(4_000);
  });
});

describe("an approved appeal with no recovery row", () => {
  // The approval's audit: one slice made, one refused, one unanswered (it may
  // have been made at Stripe), attempted a moment before the made refund.
  const ATTEMPTED_AT = "2026-06-20T00:00:00.000Z";
  const unqueuedAudit = {
    entityId: "rq-1",
    metadata: {
      cardRefundOwedCents: 2_000,
      cardRefundQueued: false,
      cardRefundRefusedCents: 1_000,
      cardRefundUnansweredCents: 1_000,
      cardRefundUnqueued: {
        attemptedAt: ATTEMPTED_AT,
        plan: [
          { paymentTransactionId: "txn-new", amountCents: 1_500, madeRefundId: "re_made" },
          { paymentTransactionId: "txn-old", amountCents: 1_000, stripeKeySuffix: "refused1" },
          { paymentTransactionId: "txn-mid", amountCents: 1_000 },
        ],
      },
    },
  };

  it("not queued: the audit row's plan is read as an operation, split into refused and unanswered", async () => {
    expect(await outcomeOf(db({ operations: [], audits: [unqueuedAudit] }))).toEqual({
      cardRefundState: "not_queued",
      cardRefundOwedCents: 2_000,
      cardRefundRefusedCents: 1_000,
      cardRefundUnansweredCents: 1_000,
      handBackOwedCents: 0,
      handBackDismissedCents: 0,
      cardRefundClosedUnpaidCents: 0,
    });
  });

  it("a refund recorded later on an unanswered slice - Stripe had made it - clears that part", async () => {
    const webhookRecorded = {
      stripeRefundId: "re_mid",
      paymentTransactionId: "txn-mid",
      amountCents: 1_000,
      status: "succeeded",
      createdAt: new Date("2026-06-20T01:00:00.000Z"),
      stripeCreatedAt: new Date("2026-06-20T00:00:02.000Z"),
    };
    const store = db({
      operations: [],
      audits: [unqueuedAudit],
      refunds: [
        { stripeRefundId: "re_made", paymentTransactionId: "txn-new", amountCents: 1_500, status: "succeeded", createdAt: MADE_AT, stripeCreatedAt: MADE_AT },
        webhookRecorded,
      ],
      refundedAmountCents: 2_500,
    });
    expect(await outcomeOf(store)).toMatchObject({ cardRefundState: "not_queued", cardRefundOwedCents: 1_000, cardRefundRefusedCents: 1_000, cardRefundUnansweredCents: 0 });
  });

  it("capped per payment: never more than the payment still holds", async () => {
    expect(await outcomeOf(db({ operations: [], audits: [unqueuedAudit], refundedAmountCents: 9_400 }))).toMatchObject({ cardRefundOwedCents: 600 });
  });

  it("an audit row that queued its retry, or carries no plan, is read as nothing owed", async () => {
    for (const metadata of [{ cardRefundOwedCents: 2_500, cardRefundQueued: true }, { cardRefundOwedCents: 2_500, cardRefundQueued: false }]) {
      expect(await outcomeOf(db({ operations: [], audits: [{ entityId: "rq-1", metadata }] }))).toMatchObject({ cardRefundState: "made", cardRefundOwedCents: 0 });
    }
  });
});

describe("two appeals on one payment share its cap (#4117)", () => {
  it("together they never read more than the payment can still give back", async () => {
    const second = operation({ id: "op-2", idempotencyKey: "refund_request_refund_rq-2", allocationPlan: [{ paymentTransactionId: "txn-two", amountCents: 1_000 }], amountCents: 1_000 });
    const store = db({ operations: [operation(), second], refundedAmountCents: 9_000 });
    const outcomes = await readApprovedAppealOutcomes(store as never, [approved, { id: "rq-2", status: "APPROVED", booking: { payment: { id: "p-1" } } }]);
    const total = (outcomes.get("rq-1")?.cardRefundOwedCents ?? 0) + (outcomes.get("rq-2")?.cardRefundOwedCents ?? 0);
    // $10.00 left on the payment, though the two rows owe $20.00 between them.
    expect(total).toBe(1_000);
    expect(outcomes.get("rq-1")?.cardRefundOwedCents).toBe(1_000);
    expect(outcomes.get("rq-2")?.cardRefundOwedCents).toBe(0);
  });
});

describe("the bank-transfer part", () => {
  it("this request's own OPEN hand-back task is still owed, and a DISMISSED one never went back; another request's is not read", async () => {
    const store = db({
      operations: [],
      tasks: [
        { occurrenceKey: "refund-request-hand-back:rq-1", amountCents: 3_000 },
        { occurrenceKey: "refund-request-hand-back:rq-1", status: "DISMISSED", amountCents: 700 },
        { occurrenceKey: "refund-request-hand-back:rq-2", amountCents: 9_000 },
      ],
    });
    expect(await outcomeOf(store)).toMatchObject({ cardRefundState: "made", handBackOwedCents: 3_000, handBackDismissedCents: 700 });
    expect(store.manualRefundTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { occurrenceKey: { in: ["refund-request-hand-back:rq-1"] }, status: { in: ["OPEN", "DISMISSED"] } } }),
    );
  });
});

it("reads nothing for a page with no approved appeal", async () => {
  const store = db();
  expect((await readApprovedAppealOutcomes(store as never, [{ ...approved, status: "PENDING" }])).size).toBe(0);
  expect(store.payment.findMany).not.toHaveBeenCalled();
});

describe("#4120: what an approved appeal has refunded, from its outcome (the screen's \"Refunded\" and the ledger census's `REFUND_APPEAL_PAID`)", () => {
  it("is the approved amount less every part not gone back: card owed, hand-back open, hand-back dismissed", () => {
    expect(approvedAppealRefundedCents(10_000, {})).toBe(10_000);
    expect(approvedAppealRefundedCents(10_000, { cardRefundOwedCents: 1_000 })).toBe(9_000);
    expect(approvedAppealRefundedCents(10_000, { handBackOwedCents: 3_000 })).toBe(7_000);
    expect(approvedAppealRefundedCents(10_000, { handBackDismissedCents: 700 })).toBe(9_300);
    expect(approvedAppealRefundedCents(10_000, { cardRefundOwedCents: 1_000, handBackOwedCents: 3_000, handBackDismissedCents: 700 })).toBe(5_300);
  });

  it("never reads below zero, nor above the approved amount", () => {
    expect(approvedAppealRefundedCents(1_000, { handBackOwedCents: 3_000 })).toBe(0);
    expect(approvedAppealRefundedCents(1_000, { cardRefundOwedCents: -500 })).toBe(1_000);
  });

  it("an outcome read from the rows: a dead card part and an open hand-back are both still owed", async () => {
    const store = db({ operations: [operation({ status: "FAILED", attempts: 5, nextRetryAt: null })], tasks: [{ occurrenceKey: "refund-request-hand-back:rq-1", amountCents: 3_000 }] });
    expect(approvedAppealRefundedCents(10_000, (await outcomeOf(store))!)).toBe(6_000);
  });
});
