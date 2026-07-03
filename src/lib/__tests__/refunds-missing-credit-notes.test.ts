import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #818 / #1162: surface refunds whose Xero credit-note follow-up never
// completed. Refunds can settle across several per-delta credit notes, so a
// payment is flagged when its refunded amount still exceeds the cents already
// covered by active refund credit notes (not merely when xeroRefundCreditNoteId
// is null).

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  sumCovered: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findMany: mocks.findMany },
  },
}));

vi.mock("@/lib/xero-sync", () => ({
  sumCoveredRefundCreditNoteCents: mocks.sumCovered,
}));

import {
  REFUND_CREDIT_NOTE_GRACE_HOURS,
  getRefundsMissingXeroCreditNotes,
} from "@/lib/xero-admin-health";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sumCovered.mockResolvedValue(0);
});

describe("getRefundsMissingXeroCreditNotes (issue #818/#1162)", () => {
  it("queries refunded, invoiced Stripe payments past the grace window without the credit-note flag", async () => {
    mocks.findMany.mockResolvedValue([]);
    const now = new Date("2026-06-21T12:00:00.000Z");

    const result = await getRefundsMissingXeroCreditNotes({ now });

    expect(result).toEqual({ count: 0, payments: [] });
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.source).toBe("STRIPE");
    expect(where.refundedAmountCents).toEqual({ gt: 0 });
    // The single-note xeroRefundCreditNoteId filter is dropped: coverage is now
    // computed per payment so multi-note refunds are handled.
    expect(where.xeroRefundCreditNoteId).toBeUndefined();
    expect(where.xeroInvoiceId).toEqual({ not: null });
    expect(where.updatedAt.lt).toEqual(
      new Date(now.getTime() - REFUND_CREDIT_NOTE_GRACE_HOURS * 60 * 60 * 1000),
    );
  });

  it("formats divergent payments with member context and honours the limit", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "pay_1",
        bookingId: "book_1",
        refundedAmountCents: 4200,
        updatedAt: new Date("2026-06-19T00:00:00.000Z"),
        booking: {
          member: {
            firstName: "Sam",
            lastName: "Lee",
            email: "sam@example.com",
          },
        },
      },
    ]);
    mocks.sumCovered.mockResolvedValue(0);

    const result = await getRefundsMissingXeroCreditNotes({ limit: 1 });

    expect(result.count).toBe(1);
    expect(result.payments[0]).toEqual({
      paymentId: "pay_1",
      bookingId: "book_1",
      memberName: "Sam Lee",
      memberEmail: "sam@example.com",
      refundedAmountCents: 4200,
      uncoveredCents: 4200,
      refundedAt: "2026-06-19T00:00:00.000Z",
    });
  });

  it("flags only the still-uncovered remainder and drops fully-covered refunds", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "pay_partial",
        bookingId: "book_1",
        refundedAmountCents: 8000,
        updatedAt: new Date("2026-06-19T00:00:00.000Z"),
        booking: {
          member: { firstName: "Sam", lastName: "Lee", email: "sam@example.com" },
        },
      },
      {
        id: "pay_covered",
        bookingId: "book_2",
        refundedAmountCents: 5000,
        updatedAt: new Date("2026-06-19T00:00:00.000Z"),
        booking: {
          member: { firstName: "Jo", lastName: "Ng", email: "jo@example.com" },
        },
      },
    ]);
    mocks.sumCovered.mockImplementation(async (paymentId: string) =>
      paymentId === "pay_partial" ? 5000 : 5000,
    );

    const result = await getRefundsMissingXeroCreditNotes();

    expect(result.count).toBe(1);
    expect(result.payments).toEqual([
      {
        paymentId: "pay_partial",
        bookingId: "book_1",
        memberName: "Sam Lee",
        memberEmail: "sam@example.com",
        refundedAmountCents: 8000,
        uncoveredCents: 3000,
        refundedAt: "2026-06-19T00:00:00.000Z",
      },
    ]);
  });
});
