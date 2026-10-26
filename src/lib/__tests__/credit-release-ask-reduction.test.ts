import { PaymentSource, PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { readUnpaidPriceAsk } from "@/lib/additional-ask-reduction";
import { CREDIT_RELEASE_ASK_REASON } from "@/lib/credit-release-ask-keys";

/*
  #4253 (`INV-ADDPAY-045`): a price reduction is never netted against an unpaid
  credit-release request. Retiring it and re-issuing a smaller one under the
  reissue reason would leave the card payment unrecognised by the Xero sweep.
*/
function row(reason: string | null) {
  return {
    id: "row-1",
    kind: PaymentTransactionKind.ADDITIONAL,
    source: PaymentSource.STRIPE,
    status: PaymentStatus.PENDING,
    reason,
    amountCents: 4000,
    carriedAskCents: 0,
    stripePaymentIntentId: "pi_1",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    withdrawnAt: null,
    hadIssuedXeroInvoice: false,
    bookingModificationId: null,
  };
}

function db(reason: string | null) {
  return {
    paymentRecoveryOperation: { findMany: vi.fn().mockResolvedValue([]) },
    paymentTransaction: { findMany: vi.fn().mockResolvedValue([row(reason)]) },
    bookingModification: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

const booking = {
  id: "bk-1",
  status: "PAID",
  payment: {
    id: "pay-1",
    additionalAmountCents: 4000,
    additionalPaymentStatus: "PENDING",
    additionalPaymentIntentId: "pi_1",
  },
} as never;

describe("a reduction against an unpaid ask", () => {
  it("sets against an ordinary edit's ask", async () => {
    const ask = await readUnpaidPriceAsk(db(null) as never, booking);
    expect(ask.askCents).toBe(4000);
  });

  it("sets against nothing when the unpaid ask is a credit-release request", async () => {
    const ask = await readUnpaidPriceAsk(db(CREDIT_RELEASE_ASK_REASON) as never, booking);
    expect(ask.askCents).toBe(0);
  });
});
