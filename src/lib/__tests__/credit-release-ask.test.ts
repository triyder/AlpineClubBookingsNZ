import { BookingStatus, CreditType, PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const mocks = vi.hoisted(() => ({
  prisma: {
    memberCredit: { findUnique: vi.fn() },
    payment: { findUnique: vi.fn() },
    paymentTransaction: { findUnique: vi.fn() },
  },
  audit: vi.fn(),
  createIntent: vi.fn(),
  upsert: vi.fn(),
  refuseAdopted: vi.fn(),
  queueSuperseded: vi.fn(),
  cancelSuperseded: vi.fn(),
  alertOfficers: vi.fn(),
  retireOutstanding: vi.fn(),
  lockPayment: vi.fn(),
  paidCash: vi.fn(),
  retireAfterWrite: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/stripe", () => ({ createPaymentIntent: mocks.createIntent }));
vi.mock("@/lib/reissued-ask-mint", () => ({
  resolveAskCustomerId: vi.fn().mockResolvedValue("cus_1"),
  mintedIntentCustomerId: vi.fn().mockReturnValue("cus_1"),
}));
vi.mock("@/lib/ordinary-ask-mint", () => ({ refuseAdoptedIntentOnLedger: mocks.refuseAdopted }));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: mocks.upsert,
  lockPaymentForRefundedTotal: mocks.lockPayment,
}));
vi.mock("@/lib/credit-release-ask-close", () => ({ recordReleasePaidInXeroCash: mocks.paidCash }));
vi.mock("@/lib/booking-payment-cleanup", async () => ({
  ...((await vi.importActual("@/lib/booking-payment-cleanup")) as typeof import("@/lib/booking-payment-cleanup")),
  queueSupersededAdditionalIntentCancellationRows: mocks.queueSuperseded,
  cancelSupersededAdditionalIntentsNow: mocks.cancelSuperseded,
}));
vi.mock("@/lib/ended-booking-ask-guard", () => ({
  retireOutstandingAskOnEndedBooking: mocks.retireOutstanding,
  replayRetiresAskOnEndedBooking: mocks.retireAfterWrite,
}));
vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers: mocks.alertOfficers }));

import { processCreditReleaseAskOperation, type CreditReleaseAskRunnerDeps } from "@/lib/credit-release-ask";
import {
  buildCreditReleaseAskRecoveryIdempotencyKey,
  buildCreditReleaseAskStripeIdempotencyKey,
  CREDIT_RELEASE_ASK_REASON,
} from "@/lib/credit-release-ask-keys";

/*
  #4253 (`INV-ADDPAY-045`): the recovery runner's branch for the released-credit request.
  Synthetic amounts. The booking below is $400.00 paid with $40.00 of account credit that
  was released, so the ledger says $40.00 is owed and unasked.
*/
const operation = {
  id: "op-1",
  bookingId: "bk-1",
  paymentId: "pay-1",
  amountCents: 4000,
  idempotencyKey: buildCreditReleaseAskRecoveryIdempotencyKey("rel-1"),
  paymentIntentId: buildCreditReleaseAskStripeIdempotencyKey("rel-1"),
  attempts: 0,
  processingStartedAt: null,
} as never;

const release = {
  type: CreditType.BOOKING_APPLIED,
  amountCents: 4000,
  appliedToBookingId: "bk-1",
  outsideSpendConvergedAt: new Date("2026-06-30T00:00:00.000Z"),
};

function payment(over: Record<string, unknown> = {}, booking: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    status: PaymentStatus.SUCCEEDED,
    amountCents: 36_000,
    refundedAmountCents: 0,
    changeFeeCents: 0,
    // The release cut the credit from 4000 to 0, so the booking is $40.00 short.
    creditAppliedCents: 0,
    additionalAmountCents: 0,
    additionalPaymentStatus: null,
    xeroInvoiceId: "inv-1",
    booking: {
      id: "bk-1",
      status: BookingStatus.CONFIRMED,
      deletedAt: null,
      organiserSettled: false,
      finalPriceCents: 40_000,
      memberId: "m-1",
      member: { id: "m-1", firstName: "A", lastName: "B", email: "a@example.test" },
      organisation: null,
      ...booking,
    },
    ...over,
  };
}

const open = { invoiceId: "inv-1", status: "AUTHORISED", amountDueCents: 4000, invoiceNumber: "INV-1" };
const paid = { invoiceId: "inv-1", status: "PAID", amountDueCents: 0, invoiceNumber: "INV-1" };

const store = { paymentRecoveryOperation: { update: vi.fn() }, payment: { findUnique: vi.fn() } };
const runnerDeps = () => ({
  holdClaim: vi.fn(async (_op: unknown, write: (s: unknown) => Promise<unknown>) => ({ value: await write(store), heldAt: new Date() })),
  complete: vi.fn().mockResolvedValue(undefined),
});

const asDeps = (d: ReturnType<typeof runnerDeps>) => d as unknown as CreditReleaseAskRunnerDeps;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.memberCredit.findUnique.mockResolvedValue(release);
  mocks.prisma.payment.findUnique.mockResolvedValue(payment());
  mocks.prisma.paymentTransaction.findUnique.mockResolvedValue({ reason: CREDIT_RELEASE_ASK_REASON });
  mocks.createIntent.mockResolvedValue({ id: "pi_new" });
  mocks.queueSuperseded.mockResolvedValue([]);
  mocks.retireAfterWrite.mockResolvedValue(false);
  mocks.paidCash.mockResolvedValue(0);
  // Under the lock the payment is as it was read, unless a test moves it.
  store.payment.findUnique.mockImplementation(async () => mocks.prisma.payment.findUnique.mock.results.at(-1)?.value);
});

async function run(over: { deps?: ReturnType<typeof runnerDeps>; balance?: unknown } = {}) {
  const deps = over.deps ?? runnerDeps();
  const read = vi.fn().mockResolvedValue(over.balance ?? open);
  await processCreditReleaseAskOperation(operation, CLUB_FORMAT_TEST, asDeps(deps), read);
  return { deps, read };
}

describe("processCreditReleaseAskOperation", () => {
  it("raises a card request for the released amount, with no edit and no supplementary invoice", async () => {
    const { deps } = await run();
    expect(mocks.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 4000,
        idempotencyKey: buildCreditReleaseAskStripeIdempotencyKey("rel-1"),
        metadata: expect.objectContaining({ bookingId: "bk-1", type: "modification_additional", reason: CREDIT_RELEASE_ASK_REASON, creditReleaseId: "rel-1" }),
      }),
    );
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-1",
        kind: PaymentTransactionKind.ADDITIONAL,
        paymentIntentId: "pi_new",
        amountCents: 4000,
        carriedAskCents: 0,
        reason: CREDIT_RELEASE_ASK_REASON,
        hadIssuedXeroInvoice: false,
        store,
      }),
    );
    expect(mocks.upsert.mock.calls[0]![0]).not.toHaveProperty("bookingModificationId");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "payment.credit_release_ask.raised" }), store);
    expect(deps.complete).toHaveBeenCalledWith("op-1");
    expect(mocks.cancelSuperseded).toHaveBeenCalledTimes(1);
  });

  it("carries a live unpaid ask it supersedes, and says so on the row", async () => {
    mocks.prisma.payment.findUnique.mockResolvedValue(
      payment({ additionalAmountCents: 2500, additionalPaymentStatus: "PENDING", additionalPaymentIntentId: "pi_rel", amountCents: 32_000 }),
    );
    await run();
    // $80.00 is short, $25.00 of it already asked, so the unasked part is $55.00 and the release's $40.00 is all of its own.
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 6500, carriedAskCents: 2500 }));
  });

  it("waits, throwing, while an unpaid edit request is open: its own invoice could not be paid by this one", async () => {
    mocks.prisma.payment.findUnique.mockResolvedValue(
      payment({ additionalAmountCents: 2500, additionalPaymentStatus: "PENDING", additionalPaymentIntentId: "pi_edit", amountCents: 32_000 }),
    );
    mocks.prisma.paymentTransaction.findUnique.mockResolvedValue({ reason: "edit_price_increase" });
    await expect(processCreditReleaseAskOperation(operation, CLUB_FORMAT_TEST, asDeps(runnerDeps()), vi.fn().mockResolvedValue(open))).rejects.toThrow(
      /unpaid edit request/,
    );
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it("asks for the smaller figure when part of the release was paid meanwhile, under a key that names the amount", async () => {
    mocks.prisma.payment.findUnique.mockResolvedValue(payment({ amountCents: 38_500 }));
    await run();
    const call = mocks.createIntent.mock.calls[0]![0];
    expect(call.amountCents).toBe(1500);
    expect(call.idempotencyKey).not.toBe(buildCreditReleaseAskStripeIdempotencyKey("rel-1"));
    expect(call.idempotencyKey).toContain("1500");
  });

  it("never asks for more than the invoice still owes", async () => {
    await run({ balance: { ...open, amountDueCents: 2500 } });
    expect(mocks.createIntent).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 2500 }));
  });

  describe("closes without asking, and says why", () => {
    const closedFor = (reason: string) => expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payment.credit_release_ask.not_raised", details: reason }),
    );

    it.each([
      ["a release that is not one", () => mocks.prisma.memberCredit.findUnique.mockResolvedValue({ ...release, outsideSpendConvergedAt: null }), "not-a-release"],
      ["a release for another booking", () => mocks.prisma.memberCredit.findUnique.mockResolvedValue({ ...release, appliedToBookingId: "bk-other" }), "not-a-release"],
      ["a missing release", () => mocks.prisma.memberCredit.findUnique.mockResolvedValue(null), "not-a-release"],
      ["a cancelled booking", () => mocks.prisma.payment.findUnique.mockResolvedValue(payment({}, { status: BookingStatus.CANCELLED })), "booking-not-owed"],
      ["a bumped booking", () => mocks.prisma.payment.findUnique.mockResolvedValue(payment({}, { status: BookingStatus.BUMPED })), "booking-not-owed"],
      ["a deleted booking", () => mocks.prisma.payment.findUnique.mockResolvedValue(payment({}, { deletedAt: new Date() })), "booking-not-owed"],
      ["a payment that was never taken", () => mocks.prisma.payment.findUnique.mockResolvedValue(payment({ status: PaymentStatus.PENDING })), "payment-not-captured"],
      ["an organiser-settled booking", () => mocks.prisma.payment.findUnique.mockResolvedValue(payment({}, { organiserSettled: true })), "organiser-settled"],
      ["a booking that owes nothing now", () => mocks.prisma.payment.findUnique.mockResolvedValue(payment({ amountCents: 40_000 })), "nothing-unasked"],
    ])("%s", async (_name, arrange, code) => {
      arrange();
      const { deps } = await run();
      closedFor(code);
      expect(deps.complete).toHaveBeenCalledWith("op-1");
      expect(mocks.createIntent).not.toHaveBeenCalled();
    });

    it("an invoice Xero already shows paid, writing the money into the ledger as paid", async () => {
      mocks.paidCash.mockResolvedValue(4000);
      const { deps } = await run({ balance: paid });
      expect(mocks.paidCash).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "pay-1", releasedCents: 4000 }));
      closedFor("invoice-settled-in-xero");
      expect(deps.complete).toHaveBeenCalled();
      expect(mocks.createIntent).not.toHaveBeenCalled();
    });

    it("an amount below the card minimum, telling the officers", async () => {
      mocks.prisma.payment.findUnique.mockResolvedValue(payment({ amountCents: 39_990 }));
      const { deps } = await run({ balance: { ...open, amountDueCents: 10 } });
      closedFor("below-card-minimum");
      expect(mocks.alertOfficers).toHaveBeenCalledTimes(1);
      expect(deps.complete).toHaveBeenCalled();
      expect(mocks.createIntent).not.toHaveBeenCalled();
    });
  });

  describe("throws, so the row retries, rather than closing a debt that is owed", () => {
    it("when the booking's invoice is not in Xero yet", async () => {
      mocks.prisma.payment.findUnique.mockResolvedValue(payment({ xeroInvoiceId: null }));
      const deps = runnerDeps();
      await expect(processCreditReleaseAskOperation(operation, CLUB_FORMAT_TEST, asDeps(deps), vi.fn())).rejects.toThrow(/not in Xero yet/);
      expect(deps.complete).not.toHaveBeenCalled();
    });

    it.each(["VOIDED", "DRAFT", ""])("when Xero shows the invoice as %j", async (status) => {
      const deps = runnerDeps();
      await expect(
        processCreditReleaseAskOperation(operation, CLUB_FORMAT_TEST, asDeps(deps), vi.fn().mockResolvedValue({ ...open, status })),
      ).rejects.toThrow(/cannot be recorded against it/);
      expect(deps.complete).not.toHaveBeenCalled();
      expect(mocks.createIntent).not.toHaveBeenCalled();
    });

    it("when Xero cannot be read", async () => {
      const deps = runnerDeps();
      await expect(
        processCreditReleaseAskOperation(operation, CLUB_FORMAT_TEST, asDeps(deps), vi.fn().mockRejectedValue(new Error("timeout"))),
      ).rejects.toThrow("timeout");
      expect(deps.complete).not.toHaveBeenCalled();
    });
  });

  it("retires the request it wrote when the booking is cancelled before the row lands, and the debt still closes", async () => {
    mocks.retireAfterWrite.mockResolvedValue(true);
    const { deps } = await run();
    expect(mocks.retireAfterWrite).toHaveBeenCalledWith(expect.objectContaining({ bookingId: "bk-1", paymentId: "pay-1", paymentIntentId: "pi_new" }));
    expect(deps.complete).toHaveBeenCalledWith("op-1");
  });

  it("a retry on a booking that has ended retires the request its failed attempt left outstanding", async () => {
    mocks.prisma.payment.findUnique.mockResolvedValue(payment({}, { status: BookingStatus.CANCELLED }));
    await run();
    expect(mocks.retireOutstanding).toHaveBeenCalledWith(expect.objectContaining({ bookingId: "bk-1", paymentId: "pay-1" }));
  });

  it.each([
    ["a capture landed", { amountCents: 38_500 }],
    ["a live ask appeared", { additionalAmountCents: 2500, additionalPaymentStatus: "PENDING" }],
    ["the live ask changed", { additionalPaymentIntentId: "pi_other" }],
  ])("throws, to retry re-sized, when %s between the read and the write", async (_name, moved) => {
    const read = payment();
    mocks.prisma.payment.findUnique.mockResolvedValue(read);
    store.payment.findUnique.mockResolvedValue({ ...read, ...moved });
    const deps = runnerDeps();
    await expect(processCreditReleaseAskOperation(operation, CLUB_FORMAT_TEST, asDeps(deps), vi.fn().mockResolvedValue(open))).rejects.toThrow(/changed while/);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("writes nothing and leaves the row open when it loses its claim", async () => {
    const deps = runnerDeps();
    deps.holdClaim.mockResolvedValue(null as never);
    await run({ deps });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
    expect(mocks.cancelSuperseded).not.toHaveBeenCalled();
  });

  it("rejects a key that names no release", async () => {
    const bad = { ...(operation as object), idempotencyKey: "something_else" } as never;
    await expect(processCreditReleaseAskOperation(bad, CLUB_FORMAT_TEST, asDeps(runnerDeps()), vi.fn())).rejects.toThrow(/no release id/);
  });
});
