import { describe, expect, it } from "vitest";

import { NO_ADDITIONAL_ASK } from "@/lib/additional-payment-ask";
import { sizeCreditReleaseAsk } from "@/lib/credit-release-ask-size";

/*
  #4253 (`INV-ADDPAY-045`) - the request for credit released after a Xero offset.
*/
describe("sizeCreditReleaseAsk", () => {
  const none = { additionalAmountCents: 0, additionalPaymentStatus: null };

  it("asks for the released amount when the ledger says it is owed and unasked", () => {
    const ask = sizeCreditReleaseAsk({ releasedCents: 4000, unaskedCents: 4000, payment: none });
    expect(ask.amountCents).toBe(4000);
    expect(ask.carriedCents).toBe(0);
  });

  it("never asks for more than the release gave back, whatever else is under-collected", () => {
    expect(sizeCreditReleaseAsk({ releasedCents: 4000, unaskedCents: 9000, payment: none }).amountCents).toBe(4000);
  });

  it("asks for less when part of the release was paid meanwhile", () => {
    expect(sizeCreditReleaseAsk({ releasedCents: 4000, unaskedCents: 1500, payment: none }).amountCents).toBe(1500);
  });

  it("asks for nothing when nothing is unasked, even with an unpaid ask outstanding", () => {
    const pending = { additionalAmountCents: 2500, additionalPaymentStatus: "PENDING" };
    expect(sizeCreditReleaseAsk({ releasedCents: 4000, unaskedCents: 0, payment: pending })).toBe(NO_ADDITIONAL_ASK);
    expect(sizeCreditReleaseAsk({ releasedCents: 0, unaskedCents: 4000, payment: none })).toBe(NO_ADDITIONAL_ASK);
  });

  it("carries the unpaid ask it supersedes", () => {
    const pending = { additionalAmountCents: 2500, additionalPaymentStatus: "PENDING" };
    const ask = sizeCreditReleaseAsk({ releasedCents: 4000, unaskedCents: 4000, payment: pending });
    expect(ask.amountCents).toBe(6500);
    expect(ask.carriedCents).toBe(2500);
  });
});
