/**
 * #3954 (`INV-PAY-120`, review round 4): the booking-vs-Xero repair pass's
 * running total of what booking edits refunded leaves out what an unpaid ask
 * took of a reduction - money nobody paid, so nothing was refunded for it - or
 * it would read a later refund request's money as already accounted for.
 */
import { describe, expect, it } from "vitest";

import { getKnownModificationRefundTotalCents } from "@/lib/xero-booking-repair-analysis";
import type { BookingRepairRecord } from "@/lib/xero-booking-repair-types";

function bookingWith(
  modifications: Array<{ priceDiffCents: number; newData: unknown }>,
  receipt: { status: string; reason: string | null } | null = null,
): BookingRepairRecord {
  return {
    modifications: modifications.map((modification, index) => ({
      id: `mod_${index}`,
      changeFeeCents: 0,
      ...modification,
    })),
    payment: {
      transactions: receipt ? [{ kind: "PRIMARY", source: "INTERNET_BANKING", ...receipt }] : [],
    },
  } as unknown as BookingRepairRecord;
}

const NO_OPERATIONS = new Map();

/** An edit's own modification note, as its outbound operation records it. */
function ownNote(requestPayload: Record<string, unknown>) {
  return {
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    queueType: "MODIFICATION_CREDIT_NOTE",
    status: "SUCCEEDED",
    requestPayload,
  };
}

describe("getKnownModificationRefundTotalCents", () => {
  it("MUTATION: an $80 reduction whose first $50 cancelled an unpaid ask refunded only $30", () => {
    expect(
      getKnownModificationRefundTotalCents(
        bookingWith([
          { priceDiffCents: 5_000, newData: {} },
          { priceDiffCents: -8_000, newData: { unpaidAskOffsetCents: 5_000 } },
        ]),
        NO_OPERATIONS,
      ),
    ).toBe(3_000);
  });

  it("a reduction the ask absorbed whole refunded nothing; an ordinary one, all of it", () => {
    expect(
      getKnownModificationRefundTotalCents(
        bookingWith([
          { priceDiffCents: -5_000, newData: { unpaidAskOffsetCents: 5_000 } },
          { priceDiffCents: -2_000, newData: {} },
        ]),
        NO_OPERATIONS,
      ),
    ).toBe(2_000);
  });
});

// #3979 (`INV-PAY-125`): an edit whose own note moved no cash refunded nothing,
// so its reduction is not part of the refunded total - or a missing refund note
// would hide behind it.
describe("getKnownModificationRefundTotalCents leaves out notes that moved no cash (#3979 review F)", () => {
  const edits = [
    { priceDiffCents: -3_000, newData: {} },
    { priceDiffCents: -2_000, newData: {} },
  ];
  const operations = (wording: Record<string, unknown>) =>
    new Map([
      ["mod_0", [ownNote(wording)]],
      ["mod_1", [ownNote({ refundMethod: "internet-banking" })]],
    ]) as unknown as Parameters<typeof getKnownModificationRefundTotalCents>[1];

  it("MUTATION: an invoice correction on a payment settled from cash refunded nothing", () => {
    expect(
      getKnownModificationRefundTotalCents(
        bookingWith(edits, { status: "SUCCEEDED", reason: "xero_invoice_paid_cash" }),
        operations({ noteWording: "invoice-correction" }),
      ),
    ).toBe(2_000);
  });

  it("an account-credit give-back never counts", () => {
    expect(
      getKnownModificationRefundTotalCents(bookingWith(edits), operations({ refundMethod: "account-credit" })),
    ).toBe(2_000);
  });

  it("an invoice correction still counts against a receipt recorded at the stored figure", () => {
    expect(
      getKnownModificationRefundTotalCents(
        bookingWith(edits, { status: "SUCCEEDED", reason: "xero_invoice_paid_reconciliation" }),
        operations({ noteWording: "invoice-correction" }),
      ),
    ).toBe(5_000);
  });
});
