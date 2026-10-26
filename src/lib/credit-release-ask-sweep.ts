import "server-only";

import { CreditType } from "@prisma/client";

import { closeCreditReleaseAsksPaidInXero, type CreditReleaseCloseResult } from "@/lib/credit-release-ask-close";
import { recordCreditReleasePayments, type CreditReleasePaymentRunResult } from "@/lib/credit-release-xero-payment";
import logger from "@/lib/logger";
import { enqueueAdditionalPaymentIntentRecovery } from "@/lib/payment-recovery";
import {
  buildCreditReleaseAskRecoveryIdempotencyKey,
  buildCreditReleaseAskStripeIdempotencyKey,
} from "@/lib/credit-release-ask-keys";
import { prisma } from "@/lib/prisma";

/**
 * THE CREDIT-RELEASE SWEEP (#4253, `INV-ADDPAY-045`): one pass of the payments
 * cron's sixth task, three steps in the order a request lives.
 *
 * 1. ENQUEUE. Every release row `convergeCreditNoteSpentOutsideApp` wrote
 *    (`outsideSpendConvergedAt`, a positive `BOOKING_APPLIED` row) that has no
 *    recovery row yet gets one, under the key that names the release
 *    (`buildCreditReleaseAskRecoveryIdempotencyKey`). The row is the durable
 *    "this release has been looked at": whatever the runner decides - ask, or close
 *    with nothing owed - the release is never looked at twice. The row freezes the
 *    release's figure only; the runner re-derives what is owed from the ledger.
 *    A release younger than the settle window is left, so the converge's caller has
 *    finished re-planning the allocation before the booking is asked for money.
 * 2. RECORD. A captured request's card payment is recorded in Xero against the
 *    booking's own invoice (`recordCreditReleasePayments`).
 * 3. CLOSE. A request Xero shows paid is closed (`closeCreditReleaseAsksPaidInXero`).
 *
 * The steps are independent and each is error-isolated: one failing never stops
 * the next, and the sweep throws after all have run so the cron's own row shows it.
 */
export const CREDIT_RELEASE_SETTLE_WINDOW_MS = 2 * 60 * 1000;

/**
 * THE WRITER'S SWITCH, OFF UNTIL SOMEONE TURNS IT ON (blue/green, two releases;
 * `docs/BLUE_GREEN_MIGRATION_POLICY.md`). Enqueueing is the only step that makes new
 * rows an older colour could pick up. A colour that does not know the key family
 * would replay such a row as an ordinary edit's, so the first release ships the
 * runner, the recorder and the closer with the producer idle; once the previous
 * colour has drained, an operator turns it on. A row in `XeroSyncCursor` (string-keyed,
 * so no migration), read live, so it takes effect on the next pass with no deploy and
 * no restart, and setting `enabled` to anything but `true` turns it off again. Only
 * the enqueue is switched: a request already raised is always carried to its end.
 *
 * THE ROW'S CREATION TIME IS THE FLOOR. Only releases written after the row was created are
 * looked at: the backlog of earlier ones is release 2's owner-decided run (#4253, D4), with the
 * live re-check and its own wording, and turning the switch on must not start it. Turning the
 * switch off and on again keeps the floor; delete the row to move it.
 */
const SWITCH_KEY = { resourceType: "CREDIT_RELEASE_ASK", scope: "WRITER" } as const;

export async function creditReleaseAskWriterSince(
  db: Pick<typeof prisma, "xeroSyncCursor"> = prisma,
): Promise<Date | null> {
  const row = await db.xeroSyncCursor.findUnique({
    where: { resourceType_scope: SWITCH_KEY },
    select: { metadata: true, createdAt: true },
  });
  const metadata = row?.metadata;
  const enabled =
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).enabled === true;
  return enabled && row ? row.createdAt : null;
}

export type CreditReleaseSweepResult = {
  enqueued: number;
  payments: CreditReleasePaymentRunResult | null;
  closes: CreditReleaseCloseResult | null;
};

export async function enqueueCreditReleaseAsks(
  options: { limit?: number; now?: Date; since: Date },
): Promise<number> {
  const now = options.now ?? new Date();
  const releases = await prisma.memberCredit.findMany({
    where: {
      type: CreditType.BOOKING_APPLIED,
      outsideSpendConvergedAt: { not: null },
      amountCents: { gt: 0 },
      appliedToBookingId: { not: null },
      createdAt: { gte: options.since, lt: new Date(now.getTime() - CREDIT_RELEASE_SETTLE_WINDOW_MS) },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, amountCents: true, appliedToBookingId: true },
  });
  if (releases.length === 0) return 0;
  const existing = await prisma.paymentRecoveryOperation.findMany({
    where: { idempotencyKey: { in: releases.map((release) => buildCreditReleaseAskRecoveryIdempotencyKey(release.id)) } },
    select: { idempotencyKey: true },
  });
  const seen = new Set(existing.map((row) => row.idempotencyKey));
  let enqueued = 0;
  for (const release of releases) {
    if (enqueued >= (options.limit ?? 25)) break;
    const idempotencyKey = buildCreditReleaseAskRecoveryIdempotencyKey(release.id);
    if (seen.has(idempotencyKey)) continue;
    const payment = await prisma.payment.findFirst({
      where: { bookingId: release.appliedToBookingId as string },
      select: { id: true },
    });
    if (!payment) {
      logger.warn({ releaseId: release.id }, "A credit release names a booking with no payment; no request raised");
      continue;
    }
    await enqueueAdditionalPaymentIntentRecovery({
      bookingId: release.appliedToBookingId as string,
      paymentId: payment.id,
      idempotencyKey,
      amountCents: release.amountCents,
      stripeIdempotencyKey: buildCreditReleaseAskStripeIdempotencyKey(release.id),
      // No supplementary invoice, ever: the money rides on the booking's own invoice.
      hadIssuedXeroInvoice: false,
    });
    enqueued += 1;
  }
  return enqueued;
}

export async function runCreditReleaseAskSweep(): Promise<CreditReleaseSweepResult> {
  const result: CreditReleaseSweepResult = { enqueued: 0, payments: null, closes: null };
  const failures: unknown[] = [];
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work();
    } catch (err) {
      logger.error({ err, step: name }, "A credit-release sweep step failed; the next step still runs");
      failures.push(err);
      return null;
    }
  };
  result.enqueued =
    (await step("enqueue", async () => {
      const since = await creditReleaseAskWriterSince();
      return since ? enqueueCreditReleaseAsks({ since }) : 0;
    })) ?? 0;
  result.payments = await step("record", () => recordCreditReleasePayments());
  result.closes = await step("close", () => closeCreditReleaseAsksPaidInXero());
  if (failures.length > 0) {
    throw new Error(`${failures.length} credit-release sweep step(s) failed; see the application logs`);
  }
  return result;
}
