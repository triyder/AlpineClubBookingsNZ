import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/xero-inbound/amounts", () => ({
  buildSyntheticAllocationLinkId: (
    creditNoteId: string,
    invoiceId: string,
    amountCents: number,
  ) => `synthetic:${creditNoteId}:${invoiceId}:${amountCents}`,
}));

import { repairLegacyAppliedCreditNoteAllocationsForBooking } from "@/lib/xero-applied-credit-allocation-repair";

const db = {
  memberCredit: {
    findMany: vi.fn(),
  },
  memberCreditNoteAllocation: {
    findFirst: vi.fn(),
    aggregate: vi.fn(),
    create: vi.fn(),
  },
  xeroObjectLink: {
    upsert: vi.fn(),
  },
};

describe("repairLegacyAppliedCreditNoteAllocationsForBooking", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.memberCredit.findMany
      .mockResolvedValueOnce([
        {
          memberId: "member-1",
          amountCents: -3000,
          xeroCreditNoteId: "cn-1",
        },
      ])
      .mockResolvedValueOnce([{ id: "lot-1", amountCents: 5000 }]);
    db.memberCreditNoteAllocation.findFirst.mockResolvedValue(null);
    db.memberCreditNoteAllocation.aggregate.mockResolvedValue({
      _sum: { amountCents: 1000 },
    });
    db.memberCreditNoteAllocation.create.mockResolvedValue({ id: "slice-1" });
    db.xeroObjectLink.upsert.mockResolvedValue({});
  });

  it("materializes an inbound-stamped applied row and its provenance link", async () => {
    const created = await repairLegacyAppliedCreditNoteAllocationsForBooking(
      "booking-1",
      "invoice-1",
      db as never,
    );

    expect(created).toBe(1);
    expect(db.memberCreditNoteAllocation.create).toHaveBeenCalledWith({
      data: {
        memberCreditId: "lot-1",
        xeroCreditNoteId: "cn-1",
        appliedToBookingId: "booking-1",
        amountCents: 3000,
      },
      select: { id: true },
    });
    expect(db.xeroObjectLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          localModel: "MemberCreditNoteAllocation",
          localId: "slice-1",
          active: true,
          metadata: expect.objectContaining({
            creditNoteId: "cn-1",
            invoiceId: "invoice-1",
            amountCents: 3000,
            repairedFromStampedMemberCredit: true,
          }),
        }),
      }),
    );
  });

  it("preserves an existing precise slice instead of recreating deallocated state", async () => {
    db.memberCreditNoteAllocation.findFirst.mockResolvedValue({ id: "slice-old" });

    const created = await repairLegacyAppliedCreditNoteAllocationsForBooking(
      "booking-1",
      "invoice-1",
      db as never,
    );

    expect(created).toBe(0);
    expect(db.memberCreditNoteAllocation.create).not.toHaveBeenCalled();
    expect(db.xeroObjectLink.upsert).not.toHaveBeenCalled();
  });

  it("fails closed when other slices leave too little of the funding lot", async () => {
    db.memberCreditNoteAllocation.aggregate.mockResolvedValue({
      _sum: { amountCents: 3000 },
    });

    await expect(
      repairLegacyAppliedCreditNoteAllocationsForBooking(
        "booking-1",
        "invoice-1",
        db as never,
      ),
    ).rejects.toThrow("exceeds remaining funding lot 2000c");
    expect(db.memberCreditNoteAllocation.create).not.toHaveBeenCalled();
  });

  it("fails closed when the stamped note has ambiguous positive funding", async () => {
    db.memberCredit.findMany.mockReset();
    db.memberCredit.findMany
      .mockResolvedValueOnce([
        {
          memberId: "member-1",
          amountCents: -3000,
          xeroCreditNoteId: "cn-1",
        },
      ])
      .mockResolvedValueOnce([
        { id: "lot-1", amountCents: 5000 },
        { id: "lot-2", amountCents: 5000 },
      ]);

    await expect(
      repairLegacyAppliedCreditNoteAllocationsForBooking(
        "booking-1",
        "invoice-1",
        db as never,
      ),
    ).rejects.toThrow("expected one positive funding lot, found 2");
    expect(db.memberCreditNoteAllocation.create).not.toHaveBeenCalled();
  });
});
