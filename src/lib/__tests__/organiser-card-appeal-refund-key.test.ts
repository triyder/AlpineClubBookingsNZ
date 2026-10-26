/**
 * #3956 review (blue/green, `INV-PAY-123`): an approved appeal's refund debt is
 * keyed OUTSIDE the `organiser_child_refund_` prefix that a worker older than
 * #3956 routes to the #3653 executor. Such a worker therefore takes the row for
 * an ordinary modification refund, meets the allocation that names no real
 * transaction, and fails it before any Stripe call - while every current reader
 * still counts it as a child refund out of the combined payment.
 */
import { describe, expect, it } from "vitest";

import {
  buildOrganiserChildAppealRefundKey,
  buildOrganiserChildCancellationRefundKey,
  buildOrganiserChildModificationRefundKey,
  isOrganiserChildAppealRefundKey,
  isOrganiserChildRefundKey,
  ORGANISER_CHILD_REFUND_KEY_WHERE,
  organiserChildRefundReasonForKey,
} from "@/lib/payment-recovery-keys";

/** The one prefix a pre-#3956 worker routes to the #3653 executor (`payment-recovery.ts` on main before #3956). */
const PRE_3956_EXECUTOR_PREFIX = "organiser_child_refund_";

const appeal = buildOrganiserChildAppealRefundKey("rr_1");
const reduction = buildOrganiserChildModificationRefundKey("mod_1");
const cancellation = buildOrganiserChildCancellationRefundKey("settlement_1", "child_1");

function matchesWhere(key: string): boolean {
  return ORGANISER_CHILD_REFUND_KEY_WHERE.OR.some((clause) => key.startsWith(clause.idempotencyKey.startsWith));
}

describe("an organiser-card appeal refund's key (#3956, INV-PAY-123)", () => {
  it("is not routed to the #3653 executor by a worker older than #3956", () => {
    expect(appeal.startsWith(PRE_3956_EXECUTOR_PREFIX), "INV-PAY-123: an appeal key under the pre-#3956 executor prefix").toBe(false);
    // CONTROL: the edit's and the group cancel's keys still are, as before.
    expect(reduction.startsWith(PRE_3956_EXECUTOR_PREFIX)).toBe(true);
    expect(cancellation.startsWith(PRE_3956_EXECUTOR_PREFIX)).toBe(true);
  });

  it("is a child refund out of the combined payment to every current reader, by predicate and by query", () => {
    for (const key of [appeal, reduction, cancellation]) {
      expect(isOrganiserChildRefundKey(key), key).toBe(true);
      expect(matchesWhere(key), `INV-PAY-123: ${key} missed by ORGANISER_CHILD_REFUND_KEY_WHERE`).toBe(true);
    }
    expect(isOrganiserChildRefundKey("refund_request_refund_rr_1")).toBe(false);
    expect(matchesWhere("refund_request_refund_rr_1")).toBe(false);
  });

  it("is told apart from the cancellation's money, and replays its own Stripe reason", () => {
    expect(isOrganiserChildAppealRefundKey(appeal)).toBe(true);
    expect(isOrganiserChildAppealRefundKey(reduction)).toBe(false);
    expect(isOrganiserChildAppealRefundKey(cancellation)).toBe(false);
    expect(organiserChildRefundReasonForKey(appeal)).toBe("organiser_child_appeal");
    expect(organiserChildRefundReasonForKey(reduction)).toBe("organiser_child_reduction");
    expect(organiserChildRefundReasonForKey(cancellation)).toBe("organiser_cancellation");
  });
});
