import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3635 round-3 R1 (`INV-PAY-110`): the cash a refund credit note may answer is
 * the payment's cash refund evidence LESS the refunds of late captures the app
 * never recorded in Xero - the one figure the enqueue, the executor, the
 * self-heal's gap reader and the hardening report all read.
 */
const state = vi.hoisted(() => ({
  refunds: [] as Array<{ paymentId: string; stripePaymentIntentId: string | null; amountCents: number; status: string }>,
  tasks: [] as Array<{ id: string; lateCaptureApprovalIntentId: string | null; reason: string | null }>,
  keptLinks: [] as Array<{ localId: string; xeroObjectId: string }>,
  resolvedKept: [] as string[],
  supplementary: [] as Array<{ paymentIntentId: string; status: string; xeroObjectId: string | null }>,
  /** #4170: captures the primary late-capture handler marked as its own write. */
  markedIntents: [] as string[],
  /** #4170: intents a cancel claim (`CANCEL_PAYMENT_INTENT` recovery) names. */
  cancelClaims: [] as string[],
  bookingStatus: "CANCELLED",
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRefund: {
      groupBy: async ({ where }: { where: { paymentId: string } }) => {
        const byStatus = new Map<string, { sum: number; count: number }>();
        for (const row of state.refunds.filter((r) => r.paymentId === where.paymentId)) {
          const bucket = byStatus.get(row.status) ?? { sum: 0, count: 0 };
          bucket.sum += row.amountCents;
          bucket.count += 1;
          byStatus.set(row.status, bucket);
        }
        return [...byStatus].map(([status, b]) => ({ status, _sum: { amountCents: b.sum }, _count: { _all: b.count } }));
      },
      findMany: async ({ where }: { where: { paymentId: string } }) =>
        state.refunds.filter((r) => r.paymentId === where.paymentId && r.stripePaymentIntentId),
    },
    memberCredit: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
    payment: { findUnique: async () => ({ booking: { status: state.bookingStatus } }) },
    paymentTransaction: {
      findMany: async ({ where }: { where: { stripePaymentIntentId: { in: string[] } } }) =>
        where.stripePaymentIntentId.in.map((intent) => ({
          stripePaymentIntentId: intent,
          reason: state.markedIntents.includes(intent) ? "cancelled_booking_late_capture" : null,
        })),
    },
    paymentRecoveryOperation: {
      findMany: async ({ where }: { where: { paymentIntentId: string | { in: string[] } } }) => {
        const asked = typeof where.paymentIntentId === "string" ? [where.paymentIntentId] : where.paymentIntentId.in;
        return state.cancelClaims.filter((intent) => asked.includes(intent)).map((paymentIntentId) => ({ paymentIntentId }));
      },
    },
    manualRefundTask: {
      // #3924 round 4: the cash evidence's paid-another-way read (on the payment, by key prefix; #4097,
      // with a paid-back card refund shortfall beside it) finds none here.
      findMany: async ({ where }: { where: { paymentId?: string; OR: [{ lateCaptureApprovalIntentId: { in: string[] } }, { reason: { in: string[] } }] } }) =>
        where.paymentId !== undefined ? [] :
        state.tasks.filter(
          (t) =>
            (t.lateCaptureApprovalIntentId && where.OR[0].lateCaptureApprovalIntentId.in.includes(t.lateCaptureApprovalIntentId)) ||
            (t.reason && where.OR[1].reason.in.includes(t.reason)),
        ),
      findUnique: async ({ where }: { where: { lateCaptureApprovalIntentId: string } }) =>
        state.tasks.find((t) => t.lateCaptureApprovalIntentId === where.lateCaptureApprovalIntentId) ?? null,
    },
    xeroObjectLink: {
      // #3924 round 10: a change's own invoice link is asked too; none here.
      findFirst: async ({ where }: { where: { localId: string; role?: string } }) =>
        where.role === "SUPPLEMENTARY_INVOICE" ? null : (state.keptLinks.find((l) => l.localId === where.localId) ?? null),
    },
    xeroSyncOperation: {
      // Round 10: the kept receipt's resolved rows are read with their invoice id.
      findMany: async ({ where }: { where: { queueType?: string; localId?: string; requestPayload?: { equals: string } } }) =>
        where.queueType === "KEPT_LATE_CAPTURE_INVOICE"
          ? state.resolvedKept.filter((id) => id === where.localId).map(() => ({ xeroObjectId: null }))
          : state.supplementary
              .filter((row) => row.paymentIntentId === where.requestPayload?.equals)
              .map((row) => ({ ...row, manuallyResolvedAt: null })),
    },
  },
}));

import { resolveRefundNoteEligibleCash } from "@/lib/refund-note-eligible-cash";
import { cancelledBookingPrimaryPaymentRefundReason } from "@/lib/deleted-booking-modification-payment";

const PAYMENT = { id: "payment_1", bookingId: "booking_1", refundedAmountCents: 34000 };

beforeEach(() => {
  state.refunds = [
    { paymentId: "payment_1", stripePaymentIntentId: "pi_ordinary", amountCents: 10000, status: "succeeded" },
    { paymentId: "payment_1", stripePaymentIntentId: "pi_late", amountCents: 24000, status: "succeeded" },
  ];
  state.tasks = [];
  state.keptLinks = [];
  state.resolvedKept = [];
  state.supplementary = [];
  state.markedIntents = [];
  state.cancelClaims = [];
  state.bookingStatus = "CANCELLED";
});

describe("resolveRefundNoteEligibleCash", () => {
  it("is the cash evidence when no refund is of a late capture", async () => {
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({
      eligibleCashCents: 34000,
      lateCaptureExcludedCents: 0,
    });
  });

  it("leaves out a refund of a late capture Xero never received, owned by an approval task", async () => {
    state.tasks = [{ id: "task_late", lateCaptureApprovalIntentId: "pi_late", reason: null }];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({
      eligibleCashCents: 10000,
      lateCaptureExcludedCents: 24000,
    });
  });

  it("leaves out a capture the primary late-capture handler marked as its own, before any record row exists (#4170)", async () => {
    state.markedIntents = ["pi_late"];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({
      eligibleCashCents: 10000,
      lateCaptureExcludedCents: 24000,
    });
  });

  it("leaves out a capture a cancel claim names, so a refund made before the late notice is not noted either (#4170)", async () => {
    state.cancelClaims = ["pi_late"];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({
      eligibleCashCents: 10000,
      lateCaptureExcludedCents: 24000,
    });
  });

  it("counts that evidence only on a cancelled booking: a superseded intent's claim on a live booking is no late capture", async () => {
    state.cancelClaims = ["pi_late"];
    state.markedIntents = ["pi_late"];
    state.bookingStatus = "CONFIRMED";
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({ eligibleCashCents: 34000 });
  });

  it("leaves out one the webhook refunded automatically, found by its frozen record reason", async () => {
    state.tasks = [
      { id: "task_auto", lateCaptureApprovalIntentId: null, reason: cancelledBookingPrimaryPaymentRefundReason("pi_late") },
    ];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({ eligibleCashCents: 10000 });
  });

  it("counts it once the app recorded the capture's receipt: its kept invoice, or its change's released invoice", async () => {
    state.tasks = [{ id: "task_late", lateCaptureApprovalIntentId: "pi_late", reason: null }];
    state.keptLinks = [{ localId: "task_late", xeroObjectId: "inv_kept" }];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({ eligibleCashCents: 34000 });

    state.keptLinks = [];
    state.supplementary = [{ paymentIntentId: "pi_late", status: "PENDING", xeroObjectId: null }];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({ eligibleCashCents: 34000 });
  });

  it("leaves out a capture whose receipt an officer recorded by hand: its refunds are recorded by hand too", async () => {
    state.tasks = [{ id: "task_late", lateCaptureApprovalIntentId: "pi_late", reason: null }];
    state.resolvedKept = ["task_late"];
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({ eligibleCashCents: 10000 });
  });

  it("does not subtract a failed refund of a late capture, which was never cash", async () => {
    state.tasks = [{ id: "task_late", lateCaptureApprovalIntentId: "pi_late", reason: null }];
    state.refunds[1].status = "failed";
    await expect(
      resolveRefundNoteEligibleCash({ ...PAYMENT, refundedAmountCents: 10000 }),
    ).resolves.toMatchObject({ eligibleCashCents: 10000, lateCaptureExcludedCents: 0 });
  });
});
