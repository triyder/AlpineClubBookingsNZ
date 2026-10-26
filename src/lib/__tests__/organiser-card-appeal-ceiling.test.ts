/**
 * #3956 round 3 (`INV-PAY-123`): `organiserCardAppealCeilingFor` - what the
 * screens and the member's appeal read - says a zero ceiling is only a WAIT
 * while the group cancel's own combined refund is not made, so no screen reads
 * it as "nothing left". The cap's own database behaviour is proved in
 * `organiser-child-refund.realdb.test.ts`; this pins the mapping.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/edit-refund-hand-back", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/edit-refund-hand-back")),
  refundAppealHandedBackParts: vi.fn().mockResolvedValue({ handBackCents: 0, lateCashCreditCents: 0, cardRefundOwedCents: 0 }),
}));

import { organiserCardAppealCeilingFor } from "@/lib/organiser-child-refund";

const BOOKING = { id: "child-1", organiserSettled: true, parentBookingId: "organiser-1", payment: { source: "STRIPE" } };
const PAYMENT = { id: "pay-1", amountCents: 10_000, refundedAmountCents: 0 };

function dbWith(settlement: Record<string, unknown> | null) {
  return {
    groupBookingSettlement: { findFirst: vi.fn().mockResolvedValue(settlement) },
    paymentRecoveryOperation: { findUnique: vi.fn().mockResolvedValue(null) },
  };
}

describe("organiserCardAppealCeilingFor (#3956)", () => {
  it("is null unless the organiser paid for the booking by card", async () => {
    const db = dbWith(null);
    expect(await organiserCardAppealCeilingFor(db as never, { ...BOOKING, organiserSettled: false }, PAYMENT as never)).toBeNull();
  });

  it("reads a pre-#3653 plan whose one combined refund is unmade as a wait, not as nothing left", async () => {
    const db = dbWith({
      id: "settlement-1",
      stripePaymentIntentId: "pi_1",
      amountCents: 30_000,
      status: "SUCCEEDED",
      refundPlan: { "child-1": 1_000 },
    });
    expect(await organiserCardAppealCeilingFor(db as never, BOOKING, PAYMENT as never)).toEqual({
      ceilingCents: 0,
      combinedRefundPending: true,
    });
  });

  it("reads a settlement that no longer holds the money as nothing left, not as a wait", async () => {
    expect(await organiserCardAppealCeilingFor(dbWith(null) as never, BOOKING, PAYMENT as never)).toEqual({
      ceilingCents: 0,
      combinedRefundPending: false,
    });
  });
});
