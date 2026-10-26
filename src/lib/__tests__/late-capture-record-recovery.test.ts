import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4149 (`INV-PAY-106`, `INV-ADDPAY-037`): a late capture's automatic refund is
 * recorded exactly once, even when the delivery that refunded it dies before
 * its record.
 *
 * The webhook route end to end, killed between the refund and the record and
 * then redelivered, is in `stripe-webhook-alerts.test.ts`; the record row's
 * exactly-once claim under `pg_advisory_xact_lock(1)`, raced for real, is in
 * `late-capture-record-recovery.realdb.test.ts`. This file pins the module's own
 * decisions: what the epilogue writes on each record outcome, what proves a
 * refund was the late-capture door's, and what the nightly self-heal checks.
 */

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  announce: vi.fn(),
  landedAfter: vi.fn(),
  queueNote: vi.fn(),
  findClosed: vi.fn(),
  listRefunds: vi.fn(),
  logAudit: vi.fn(),
  getClubFormat: vi.fn(),
  auditLogFindMany: vi.fn(),
  paymentFindUnique: vi.fn(),
  refundCentsByIntent: vi.fn(),
  paymentTransactionFindUnique: vi.fn(),
  held: vi.fn(),
  supersededOps: vi.fn(),
  doorReplays: vi.fn(),
  markerUpsert: vi.fn(),
  refundRows: vi.fn(),
  markedRows: vi.fn(),
}));

vi.mock("@/lib/cancelled-booking-late-capture", () => ({
  recordAutomaticLateCaptureRefund: (...args: unknown[]) => mocks.record(...args),
  announceAutomaticLateCaptureRefund: (...args: unknown[]) => mocks.announce(...args),
  lateCaptureDoubleRefundAlertKey: (paymentIntentId: string) => `late-capture-double-refund:${paymentIntentId}`,
}));
vi.mock("@/lib/late-capture-landed-after", () => ({
  readCaptureLandedAfterCancellation: (...args: unknown[]) => mocks.landedAfter(...args),
}));
vi.mock("@/lib/admin-alert-once", () => ({
  findHeldOnceEverAlertKeys: (...args: unknown[]) => mocks.held(...args),
}));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({
  queueLateCaptureRefundCreditNote: (...args: unknown[]) => mocks.queueNote(...args),
  lateCaptureAuditKind: (kind: string | null) => (kind === null ? null : kind === "primary" ? "primary" : "modification_additional"),
}));
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  findClosedLateCaptureRecords: (...args: unknown[]) => mocks.findClosed(...args),
}));
vi.mock("@/lib/refund-note-eligible-cash", () => ({
  readRecordedRefundCentsByIntent: (...args: unknown[]) => mocks.refundCentsByIntent(...args),
}));
vi.mock("@/lib/stripe", () => ({
  listRefundsForPaymentIntent: (...args: unknown[]) => mocks.listRefunds(...args),
}));
vi.mock("@/lib/audit", () => ({ logAudit: (...args: unknown[]) => mocks.logAudit(...args) }));
vi.mock("@/lib/club-format-settings", () => ({ getClubFormat: () => mocks.getClubFormat() }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: (...args: unknown[]) => mocks.auditLogFindMany(...args) },
    payment: { findUnique: (...args: unknown[]) => mocks.paymentFindUnique(...args) },
    paymentTransaction: {
      findUnique: (...args: unknown[]) => mocks.paymentTransactionFindUnique(...args),
      // The primary handler's own marked writes, for the known-door-refund check.
      findMany: (...args: unknown[]) => mocks.markedRows(...args),
    },
    paymentRefund: { findMany: (...args: unknown[]) => mocks.refundRows(...args) },
    alertCooldown: { upsert: (...args: unknown[]) => mocks.markerUpsert(...args) },
    paymentRecoveryOperation: {
      // The superseded-payment refund's rows, or the door's refund replays by Stripe key.
      findMany: (args: { where: { type?: string } }) =>
        args.where.type === "REFUND_SUPERSEDED_PAYMENT" ? mocks.supersededOps(args) : mocks.doorReplays(args),
    },
  },
}));

import {
  LateCaptureRecordLostError,
  finishAutomaticLateCaptureRefund,
  recoverLostLateCaptureRecord,
  recoverLostLateCaptureRecordsForPayment,
  findSupersededRefundOnlyIntents,
  type LateCaptureIdentity,
  type LateCaptureRecordBooking,
} from "@/lib/late-capture-record-recovery";
import type { CancelledBookingLateCapture } from "@/lib/cancelled-booking-late-capture";
import { buildLateCaptureRefundMetadata, LATE_CAPTURE_REPAIR_REFUND_METADATA_REASON } from "@/lib/payment-recovery-keys";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const INTENT = "pi_late";
const REFUNDED_ON = new Date("2026-06-25T03:00:00.000Z");

function capture(overrides: Partial<CancelledBookingLateCapture> = {}): CancelledBookingLateCapture {
  return {
    bookingId: "booking-1",
    paymentId: "payment-1",
    paymentIntentId: INTENT,
    amountCents: 2500,
    memberName: "Alice Example",
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    openingDeletedAt: null,
    captureKind: "primary",
    ...overrides,
  };
}

const BOOKING: LateCaptureRecordBooking = {
  checkIn: new Date("2026-08-01"),
  checkOut: new Date("2026-08-03"),
  deletedAt: null,
  memberId: "member-1",
  member: { firstName: "Alice", lastName: "Example" },
  organisation: null,
};
const IDENTITY: LateCaptureIdentity = {
  bookingId: "booking-1",
  paymentId: "payment-1",
  paymentIntentId: INTENT,
  amountCents: 2500,
  transactionKind: "PRIMARY",
};

const RECORDED = { bookingDeleted: false, recorded: true, alreadyRecorded: false, handCompletedAfterRefund: false };
/** A refund as Stripe lists it, sent by the late-capture door for booking-1 unless told otherwise. */
const stripeRefund = (overrides: Record<string, unknown> = {}) => ({
  id: "re_late_1",
  amount: 2500,
  status: "succeeded",
  created: Math.floor(REFUNDED_ON.getTime() / 1000),
  metadata: buildLateCaptureRefundMetadata("booking-1"),
  ...overrides,
});
const entriesOf = (action: string) =>
  mocks.logAudit.mock.calls
    .map(([entry]) => entry as { action: string; details: string })
    .filter((entry) => entry.action === action)
    .map((entry) => JSON.parse(entry.details) as Record<string, unknown>);
const refundEntries = () => entriesOf("booking.payment.refunded_after_cancellation");
/** A stored audit row naming the capture, as `findMany` returns it. */
const refundTimeEntry = (extra: Record<string, unknown> = {}, paymentIntentId = INTENT) => ({
  details: JSON.stringify({ paymentIntentId, refundId: "re_late_1", amountCents: 2500, kind: "primary", ...extra }),
});
const recoveredEntries = () => entriesOf("booking.payment.auto_refund_record_recovered");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.record.mockResolvedValue(RECORDED);
  mocks.announce.mockResolvedValue(undefined);
  mocks.queueNote.mockResolvedValue(undefined);
  mocks.findClosed.mockResolvedValue(new Map());
  mocks.listRefunds.mockResolvedValue([stripeRefund()]);
  mocks.landedAfter.mockResolvedValue(true);
  mocks.getClubFormat.mockResolvedValue(CLUB_FORMAT_TEST);
  // No once-ever claim is held, and no superseded-payment refund made any refund.
  mocks.held.mockResolvedValue(new Set());
  mocks.supersededOps.mockResolvedValue([]);
  mocks.doorReplays.mockResolvedValue([]);
  mocks.markerUpsert.mockResolvedValue({});
  mocks.refundRows.mockResolvedValue([]);
  mocks.markedRows.mockResolvedValue([]);
  // By default the delivery that refunded wrote its entry, marked: its record write was lost.
  mocks.auditLogFindMany.mockResolvedValue([refundTimeEntry({ recordLost: true })]);
});

describe("finishAutomaticLateCaptureRefund — the one epilogue", () => {
  it("writes the record, then the refund entry, the alert and the note", async () => {
    await finishAutomaticLateCaptureRefund({
      capture: capture({ captureKind: "modification" }),
      format: CLUB_FORMAT_TEST,
      refundId: "re_late_1",
      auditDetail: { extra: 1 },
    });

    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(refundEntries()).toEqual([
      { paymentIntentId: INTENT, refundId: "re_late_1", amountCents: 2500, kind: "modification_additional", extra: 1 },
    ]);
    expect(mocks.announce).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: INTENT }), RECORDED, CLUB_FORMAT_TEST);
    expect(mocks.queueNote).toHaveBeenCalledWith({ paymentId: "payment-1", paymentIntentId: INTENT });
  });

  it("still writes the entry and sends the alert when the record write is lost, marks the entry, and only then throws for the 500", async () => {
    const lost = { ...RECORDED, recorded: false };
    mocks.record.mockResolvedValueOnce(lost);

    await expect(
      finishAutomaticLateCaptureRefund({ capture: capture(), format: CLUB_FORMAT_TEST, refundId: "re_late_1", auditDetail: { refundedNowCents: 2500 } }),
    ).rejects.toBeInstanceOf(LateCaptureRecordLostError);

    // INV-ADDPAY-037: never neither - the recovery that writes the row sends no second alert.
    expect(refundEntries()).toEqual([
      { paymentIntentId: INTENT, refundId: "re_late_1", amountCents: 2500, kind: "primary", refundedNowCents: 2500, recordLost: true },
    ]);
    expect(mocks.announce).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: INTENT }), lost, CLUB_FORMAT_TEST);
    // The note waits for the row the recovery writes.
    expect(mocks.queueNote).not.toHaveBeenCalled();
  });

  it("is not deduped when another delivery's row was already there: a duplicate, never a silence (#2761)", async () => {
    mocks.record.mockResolvedValueOnce({ ...RECORDED, alreadyRecorded: "self" });

    await finishAutomaticLateCaptureRefund({ capture: capture(), format: CLUB_FORMAT_TEST, refundId: "re_late_1" });

    expect(refundEntries()).toHaveLength(1);
    expect(mocks.announce).toHaveBeenCalledTimes(1);
    // Sized against the notes already raised for the capture, so asking again is safe.
    expect(mocks.queueNote).toHaveBeenCalledTimes(1);
  });

  it("never lets the alert's failure fail the epilogue", async () => {
    mocks.announce.mockRejectedValueOnce(new Error("mail provider down"));
    await expect(
      finishAutomaticLateCaptureRefund({ capture: capture(), format: CLUB_FORMAT_TEST, refundId: null }),
    ).resolves.toBeUndefined();
    expect(mocks.queueNote).toHaveBeenCalledTimes(1);
  });
});

describe("recoverLostLateCaptureRecord — a redelivery's check", () => {
  it("writes the missing row and its own entry, and sends the alert again, when the refund-time entry says the record write was lost", async () => {
    mocks.listRefunds.mockResolvedValueOnce([
      stripeRefund({ id: "re_late_2", amount: 500, created: Math.floor(REFUNDED_ON.getTime() / 1000) + 60 }),
      stripeRefund(),
    ]);

    await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).resolves.toBe(true);

    // Bounded and never retried on the webhook path.
    expect(mocks.listRefunds).toHaveBeenCalledWith(INTENT, { timeoutMs: 5_000 });
    // Fetched by action and booking and matched in code: no LIKE on the stored text (#4146).
    expect(mocks.auditLogFindMany).toHaveBeenCalledWith({
      where: { action: "booking.payment.refunded_after_cancellation", entityId: "booking-1" },
      select: { details: true },
    });
    // Dated the refund's day, from the earliest refund the door sent.
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: INTENT, memberName: "Alice Example", captureKind: "primary" }),
      { completedAt: REFUNDED_ON },
    );
    expect(recoveredEntries()).toEqual([
      {
        paymentIntentId: INTENT,
        refundId: "re_late_1",
        amountCents: 2500,
        refundedCents: 3000,
        kind: "primary",
        refundTimeReport: "record_lost",
        alertSent: true,
      },
    ]);
    // The permanent refund entry is not written twice; the alert, which may have failed with the database, is.
    expect(refundEntries()).toHaveLength(0);
    expect(mocks.announce).toHaveBeenCalledTimes(1);
    expect(mocks.queueNote).toHaveBeenCalledWith({ paymentId: "payment-1", paymentIntentId: INTENT });
  });

  it("sends no second alert when the refund-time entry is one whose record write did not fail", async () => {
    mocks.auditLogFindMany.mockResolvedValueOnce([refundTimeEntry()]);

    await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).resolves.toBe(true);

    expect(recoveredEntries()).toEqual([expect.objectContaining({ refundTimeReport: "reported", alertSent: false })]);
    expect(mocks.announce).not.toHaveBeenCalled();
  });

  it("also writes the refund entry and sends the alert when the delivery that refunded died before either", async () => {
    // Entries for another capture of the booking, and an unreadable one, are not this capture's.
    mocks.auditLogFindMany.mockResolvedValueOnce([refundTimeEntry({}, "pi_other"), { details: "{not json" }, { details: null }]);

    await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).resolves.toBe(true);

    expect(recoveredEntries()).toEqual([expect.objectContaining({ refundTimeReport: "none", alertSent: true })]);
    expect(refundEntries()).toEqual([
      { paymentIntentId: INTENT, refundId: "re_late_1", amountCents: 2500, kind: "primary", refundedCents: 2500, recoveredLostRecord: true },
    ]);
    expect(mocks.announce).toHaveBeenCalledTimes(1);
  });

  it("treats an intent Stripe no longer knows as holding no door refund, so it neither throws nor records", async () => {
    mocks.listRefunds.mockRejectedValueOnce(Object.assign(new Error("No such payment_intent"), { code: "resource_missing" }));

    await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).resolves.toBe(false);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    ["exists in the other mode", "No such payment_intent: 'pi_late'; a similar object exists in live mode, but a test mode key was used to make this request."],
    ["exists on another account", "No such payment_intent: 'pi_late'. It belongs to a different account."],
  ])("lets resource_missing through when Stripe says the intent %s: a configuration fault, so unresolved", async (_label, message) => {
    mocks.listRefunds.mockRejectedValueOnce(Object.assign(new Error(message), { code: "resource_missing" }));
    await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).rejects.toThrow(message);
  });

  describe("#2774's residual double payment, hidden by the lost record", () => {
    it("escalates a hand-COMPLETED #2700 row beside a door refund through the record writer's own once-ever escalation", async () => {
      mocks.findClosed.mockResolvedValueOnce(new Map([[INTENT, "hand-completed"]]));

      await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).resolves.toBe(false);

      // Gated on the once-ever claim, read first - never on an audit entry.
      expect(mocks.held).toHaveBeenCalledWith([`late-capture-double-refund:${INTENT}`], expect.any(Date));
      expect(mocks.auditLogFindMany).not.toHaveBeenCalled();
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: INTENT }),
        expect.objectContaining({ handCompletedAfterRefund: true }),
        CLUB_FORMAT_TEST,
      );
      // The operator's row is the record: none is written beside it.
      expect(mocks.record).not.toHaveBeenCalled();
      expect(recoveredEntries()).toHaveLength(0);
    });

    it("asks Stripe nothing and escalates nothing while the escalation's claim is held", async () => {
      mocks.findClosed.mockResolvedValueOnce(new Map([[INTENT, "hand-completed"]]));
      mocks.held.mockResolvedValueOnce(new Set([`late-capture-double-refund:${INTENT}`]));

      await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).resolves.toBe(false);
      expect(mocks.listRefunds).not.toHaveBeenCalled();
      expect(mocks.announce).not.toHaveBeenCalled();
    });

    it("raises it again when the claim was given back after a send that failed, even though its entry was written", async () => {
      mocks.findClosed.mockResolvedValueOnce(new Map([[INTENT, "hand-completed"]]));
      mocks.auditLogFindMany.mockResolvedValue([refundTimeEntry({ refundSent: true })]);

      await recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST });
      expect(mocks.announce).toHaveBeenCalledTimes(1);
    });

    it("does not escalate a hand-COMPLETED row when Stripe holds no door refund, and marks it checked so the nightly list stops asking", async () => {
      mocks.findClosed.mockResolvedValueOnce(new Map([[INTENT, "hand-completed"]]));
      mocks.listRefunds.mockResolvedValueOnce([stripeRefund({ metadata: {} })]);

      await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).resolves.toBe(false);
      expect(mocks.announce).not.toHaveBeenCalled();
      expect(mocks.markerUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: `late-capture-hand-completed-checked:${INTENT}` } }),
      );
    });

    it("writes no checked marker when the Stripe read throws: nothing was checked", async () => {
      mocks.findClosed.mockResolvedValueOnce(new Map([[INTENT, "hand-completed"]]));
      mocks.listRefunds.mockRejectedValueOnce(new Error("Stripe is unreachable"));

      await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).rejects.toThrow("Stripe is unreachable");
      expect(mocks.markerUpsert).not.toHaveBeenCalled();
    });
  });

  it("recovers a lost record of the repair tool's own refund as the repair tool would: record, recovered entry and note, no refund entry or alert", async () => {
    mocks.auditLogFindMany.mockResolvedValueOnce([]);
    mocks.listRefunds.mockResolvedValueOnce([
      stripeRefund({ metadata: { bookingId: "booking-1", reason: LATE_CAPTURE_REPAIR_REFUND_METADATA_REASON } }),
    ]);

    await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).resolves.toBe(true);
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(recoveredEntries()).toEqual([expect.objectContaining({ repairRefund: true, alertSent: false })]);
    expect(refundEntries()).toHaveLength(0);
    expect(mocks.announce).not.toHaveBeenCalled();
    expect(mocks.queueNote).toHaveBeenCalledWith({ paymentId: "payment-1", paymentIntentId: INTENT });
  });

  it("still reports a door refund beside a repair refund as the automatic one it is", async () => {
    mocks.auditLogFindMany.mockResolvedValueOnce([]);
    mocks.listRefunds.mockResolvedValueOnce([
      stripeRefund(),
      stripeRefund({ id: "re_repair", metadata: { bookingId: "booking-1", reason: LATE_CAPTURE_REPAIR_REFUND_METADATA_REASON } }),
    ]);

    await recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST });
    expect(refundEntries()).toHaveLength(1);
    expect(mocks.announce).toHaveBeenCalledTimes(1);
  });

  it("names an unknown member rather than failing when the booking's owner cannot be read", async () => {
    await recoverLostLateCaptureRecord({ ...BOOKING, memberId: null, member: null }, IDENTITY, { format: CLUB_FORMAT_TEST });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ memberName: "unknown member" }), expect.anything());
  });

  it("asks Stripe nothing when the capture already has a closed record", async () => {
    mocks.findClosed.mockResolvedValueOnce(new Map([[INTENT, "record"]]));

    await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).resolves.toBe(false);
    expect(mocks.findClosed).toHaveBeenCalledWith([INTENT]);
    expect(mocks.listRefunds).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    ["a dashboard refund (no metadata)", { metadata: {} }],
    ["another booking's late-capture refund", { metadata: buildLateCaptureRefundMetadata("booking-2") }],
    ["a refund Stripe refused", { status: "failed" }],
  ])("records nothing for %s", async (_label, overrides) => {
    mocks.listRefunds.mockResolvedValueOnce([stripeRefund(overrides)]);

    await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).resolves.toBe(false);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([["self"], ["hand-resolved"]])(
    "reports nothing recovered, and writes nothing, when the writer found a row (%s) another writer made first",
    async (alreadyRecorded) => {
      mocks.record.mockResolvedValueOnce({ ...RECORDED, alreadyRecorded });

      await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).resolves.toBe(false);
      expect(mocks.logAudit).not.toHaveBeenCalled();
      expect(mocks.announce).not.toHaveBeenCalled();
      expect(mocks.queueNote).not.toHaveBeenCalled();
    },
  );

  it("throws when its own record write is lost, so the webhook answers 500 again", async () => {
    mocks.record.mockResolvedValueOnce({ ...RECORDED, recorded: false });
    await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).rejects.toBeInstanceOf(
      LateCaptureRecordLostError,
    );
    expect(recoveredEntries()).toHaveLength(0);
  });

  it("lets a Stripe failure through, so the webhook answers 500 rather than acknowledging", async () => {
    mocks.listRefunds.mockRejectedValueOnce(new Error("Stripe is unreachable"));
    await expect(recoverLostLateCaptureRecord(BOOKING, IDENTITY, { format: CLUB_FORMAT_TEST })).rejects.toThrow(
      "Stripe is unreachable",
    );
  });
});

describe("recoverLostLateCaptureRecordsForPayment — the nightly self-heal's check", () => {
  function armPayment(status = "CANCELLED", lateKind: "PRIMARY" | "ADDITIONAL" = "PRIMARY") {
    mocks.paymentFindUnique.mockResolvedValue({ bookingId: "booking-1", booking: { status, ...BOOKING } });
    mocks.refundCentsByIntent.mockResolvedValue(
      new Map([
        [INTENT, 2500],
        ["pi_cancel", 12000],
      ]),
    );
    mocks.paymentTransactionFindUnique.mockImplementation(async ({ where }: { where: { stripePaymentIntentId: string } }) => ({
      paymentId: "payment-1",
      kind: where.stripePaymentIntentId === INTENT ? lateKind : "PRIMARY",
      amountCents: where.stripePaymentIntentId === INTENT ? 2500 : 12000,
      reason: where.stripePaymentIntentId === INTENT && lateKind === "PRIMARY" ? "cancelled_booking_late_capture" : null,
    }));
    mocks.landedAfter.mockImplementation(async ({ paymentIntentId }: { paymentIntentId: string }) => paymentIntentId === INTENT && lateKind === "PRIMARY");
  }

  it("records a late capture whose record was lost, with a bounded Stripe read, and leaves the cancel's own refund alone", async () => {
    armPayment();

    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [INTENT], unresolved: false });

    expect(mocks.refundCentsByIntent).toHaveBeenCalledWith("payment-1");
    // Only the capture that landed after the cancel is asked about.
    expect(mocks.listRefunds).toHaveBeenCalledTimes(1);
    expect(mocks.listRefunds).toHaveBeenCalledWith(INTENT, { timeoutMs: 10_000 });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: INTENT, amountCents: 2500, memberName: "Alice Example", captureKind: "primary" }),
      { completedAt: REFUNDED_ON },
    );
  });

  it("checks a change payment's capture even with no evidence it landed after the cancel: its handler stamps no marker (#4149)", async () => {
    armPayment("CANCELLED", "ADDITIONAL");

    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [INTENT], unresolved: false });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ captureKind: "modification" }), expect.anything());
  });

  it("asks Stripe nothing for a capture the superseded-payment refund refunded (#4173): no late-capture door sent it", async () => {
    armPayment("CANCELLED", "ADDITIONAL");
    mocks.supersededOps.mockResolvedValue([{ paymentIntentId: INTENT, createdAt: new Date("2026-06-25T00:00:00Z"), succeededAt: new Date("2026-06-25T00:10:00Z") }]);
    mocks.refundRows.mockResolvedValue([{ stripePaymentIntentId: INTENT, amountCents: 2500, status: "succeeded", createdAt: new Date("2026-06-25T00:05:00Z") }]);

    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: false });
    expect(mocks.listRefunds).not.toHaveBeenCalled();
  });

  it("checks nothing on a booking that is not cancelled", async () => {
    armPayment("CONFIRMED");
    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: false });
    expect(mocks.refundCentsByIntent).not.toHaveBeenCalled();
    expect(mocks.listRefunds).not.toHaveBeenCalled();
  });

  it("skips a capture that already has its closed record", async () => {
    armPayment();
    mocks.findClosed.mockResolvedValueOnce(new Map([[INTENT, "record"]]));
    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: false });
    expect(mocks.listRefunds).not.toHaveBeenCalled();
  });

  it("does not count a capture another writer recorded first as recovered", async () => {
    armPayment();
    mocks.record.mockResolvedValueOnce({ ...RECORDED, alreadyRecorded: "self" });
    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: false });
  });

  it("says it could not check when Stripe or the record write fails, so the caller raises no card note tonight", async () => {
    armPayment();
    mocks.listRefunds.mockRejectedValueOnce(new Error("timeout"));
    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: true });

    mocks.record.mockResolvedValueOnce({ ...RECORDED, recorded: false });
    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: true });
  });

  it("does not hold the payment's note back every night for an intent Stripe no longer knows", async () => {
    armPayment();
    mocks.listRefunds.mockRejectedValueOnce(Object.assign(new Error("No such payment_intent"), { code: "resource_missing" }));
    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: false });
  });

  it("says it could not check when its own reads fail, and never throws", async () => {
    mocks.paymentFindUnique.mockRejectedValueOnce(new Error("database is down"));
    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: true });
  });
});

describe("findSupersededRefundOnlyIntents — #4173's skip", () => {
  const capture = (refundedCents = 2500) => new Map([[INTENT, { refundedCents, bookingId: "booking-1" }]]);
  const ROW = { paymentIntentId: INTENT, createdAt: new Date("2026-06-25T00:00:00Z"), succeededAt: new Date("2026-06-25T00:10:00Z") };
  const refundAt = (iso: string, amountCents = 2500) => ({ stripePaymentIntentId: INTENT, amountCents, status: "succeeded", createdAt: new Date(iso) });

  it("skips a capture whose recorded refunds a SUCCEEDED superseded row made in full, with no door refund known", async () => {
    mocks.supersededOps.mockResolvedValueOnce([ROW]);
    mocks.refundRows.mockResolvedValueOnce([refundAt("2026-06-25T00:05:00Z")]);
    mocks.auditLogFindMany.mockResolvedValueOnce([]);

    await expect(findSupersededRefundOnlyIntents(capture())).resolves.toEqual(new Set([INTENT]));
    expect(mocks.supersededOps).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: "REFUND_SUPERSEDED_PAYMENT", status: "SUCCEEDED" }) }),
    );
  });

  it("does not skip a capture the superseded row refunded nothing of: its refund landed before the row existed", async () => {
    mocks.supersededOps.mockResolvedValueOnce([ROW]);
    mocks.refundRows.mockResolvedValueOnce([refundAt("2026-06-24T00:00:00Z")]);
    await expect(findSupersededRefundOnlyIntents(capture())).resolves.toEqual(new Set());
  });

  it("does not skip one the superseded row refunded only in part", async () => {
    mocks.supersededOps.mockResolvedValueOnce([ROW]);
    mocks.refundRows.mockResolvedValueOnce([refundAt("2026-06-25T00:05:00Z", 1000)]);
    await expect(findSupersededRefundOnlyIntents(capture())).resolves.toEqual(new Set());
  });

  it("does not skip one the primary late-capture handler marked: #4149's crash leaves no other sign of its door refund", async () => {
    mocks.supersededOps.mockResolvedValueOnce([ROW]);
    mocks.refundRows.mockResolvedValueOnce([refundAt("2026-06-25T00:05:00Z")]);
    mocks.markedRows.mockResolvedValueOnce([{ stripePaymentIntentId: INTENT, reason: "cancelled_booking_late_capture" }]);
    await expect(findSupersededRefundOnlyIntents(capture())).resolves.toEqual(new Set());
  });

  it("does not skip one with a door refund known beside the superseded refund: its refund-time entry", async () => {
    mocks.supersededOps.mockResolvedValueOnce([ROW]);
    mocks.refundRows.mockResolvedValueOnce([refundAt("2026-06-25T00:05:00Z")]);
    mocks.auditLogFindMany.mockResolvedValueOnce([{ entityId: "booking-1", details: JSON.stringify({ paymentIntentId: INTENT }) }]);
    await expect(findSupersededRefundOnlyIntents(capture())).resolves.toEqual(new Set());
  });

  it("does not skip one with a door refund known beside the superseded refund: a replay of the door's refund", async () => {
    mocks.supersededOps.mockResolvedValueOnce([ROW]);
    mocks.refundRows.mockResolvedValueOnce([refundAt("2026-06-25T00:05:00Z")]);
    mocks.auditLogFindMany.mockResolvedValueOnce([]);
    mocks.doorReplays.mockResolvedValueOnce([{ stripeKeyPrefix: `late_cancel_refund_booking-1_${INTENT}` }]);
    await expect(findSupersededRefundOnlyIntents(capture())).resolves.toEqual(new Set());
    expect(mocks.doorReplays).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stripeKeyPrefix: { in: [`late_cancel_refund_booking-1_${INTENT}`] } } }),
    );
  });
});
