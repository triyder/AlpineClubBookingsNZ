import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/xero-inbound/amounts", () => ({
  buildSyntheticAllocationLinkId: (
    creditNoteId: string,
    invoiceId: string,
    amountCents: number,
  ) => `synthetic:${creditNoteId}:${invoiceId}:${amountCents}`,
}));

import { repairLegacyAppliedCreditNoteAllocationsForBooking } from "@/lib/xero-applied-credit-allocation-repair";

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const db = {
  memberCredit: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  memberCreditNoteAllocation: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  xeroObjectLink: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
};

function ledger(amountCents = -3000) {
  return [{
    memberId: "member-1",
    amountCents,
    xeroCreditNoteId: amountCents < 0 ? "cn-1" : null,
  }];
}

function slice(amountCents = 3000) {
  return {
    id: "slice-1",
    memberCreditId: "lot-1",
    xeroCreditNoteId: "cn-1",
    amountCents,
    createdAt,
  };
}

function activeLink(amountCents = 3000) {
  return {
    id: "link-1",
    metadata: {
      creditNoteId: "cn-1",
      invoiceId: "invoice-1",
      amountCents,
      rowTargetCents: amountCents,
    },
  };
}

describe("repairLegacyAppliedCreditNoteAllocationsForBooking", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.memberCredit.findMany
      .mockResolvedValueOnce(ledger())
      .mockResolvedValueOnce([{ id: "lot-1", amountCents: 5000 }]);
    db.memberCredit.findUnique.mockResolvedValue({
      memberId: "member-1",
      amountCents: 5000,
      xeroCreditNoteId: "cn-1",
    });
    db.memberCreditNoteAllocation.findMany.mockResolvedValue([]);
    db.memberCreditNoteAllocation.aggregate.mockResolvedValue({
      _sum: { amountCents: 1000 },
    });
    db.memberCreditNoteAllocation.create.mockResolvedValue({
      id: "slice-1",
      createdAt,
    });
    db.memberCreditNoteAllocation.update.mockImplementation(async ({ data }) => ({
      ...slice(data.amountCents),
    }));
    db.memberCreditNoteAllocation.delete.mockResolvedValue({});
    db.xeroObjectLink.findMany.mockResolvedValue([]);
    db.xeroObjectLink.updateMany.mockResolvedValue({ count: 1 });
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
      select: { id: true, createdAt: true },
    });
    expect(db.xeroObjectLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          localId: "slice-1",
          active: true,
          metadata: expect.objectContaining({
            creditNoteId: "cn-1",
            invoiceId: "invoice-1",
            amountCents: 3000,
          }),
        }),
      }),
    );
  });

  it("does not recreate a fully deallocated historical slice", async () => {
    db.memberCredit.findMany.mockReset();
    db.memberCredit.findMany.mockResolvedValueOnce([
      { memberId: "member-1", amountCents: -3000, xeroCreditNoteId: "cn-1" },
      { memberId: "member-1", amountCents: 3000, xeroCreditNoteId: null },
    ]);

    await expect(
      repairLegacyAppliedCreditNoteAllocationsForBooking(
        "booking-1", "invoice-1", db as never,
      ),
    ).resolves.toBe(0);
    expect(db.memberCreditNoteAllocation.create).not.toHaveBeenCalled();
    expect(db.xeroObjectLink.upsert).not.toHaveBeenCalled();
    expect(db.xeroObjectLink.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed instead of silently accepting an existing slice mismatch", async () => {
    db.memberCreditNoteAllocation.findMany.mockResolvedValue([slice(2500)]);

    await expect(
      repairLegacyAppliedCreditNoteAllocationsForBooking(
        "booking-1", "invoice-1", db as never,
      ),
    ).rejects.toThrow("total 2500c but ledger permits 3000c..3000c");
    expect(db.xeroObjectLink.upsert).not.toHaveBeenCalled();
  });

  it("fails closed when an existing slice has no active provider provenance", async () => {
    db.memberCreditNoteAllocation.findMany.mockResolvedValue([slice(3000)]);

    await expect(
      repairLegacyAppliedCreditNoteAllocationsForBooking(
        "booking-1", "invoice-1", db as never,
      ),
    ).rejects.toThrow("slice slice-1 has no active Xero provenance");
    expect(db.xeroObjectLink.upsert).not.toHaveBeenCalled();
  });

  it("accepts the bounded pre-deallocation mismatch created by a positive clamp offset", async () => {
    db.memberCredit.findMany.mockReset();
    db.memberCredit.findMany.mockResolvedValueOnce([
      { memberId: "member-1", amountCents: -3000, xeroCreditNoteId: "cn-1" },
      { memberId: "member-1", amountCents: 1000, xeroCreditNoteId: null },
    ]);
    db.memberCreditNoteAllocation.findMany.mockResolvedValue([slice(3000)]);
    db.xeroObjectLink.findMany.mockResolvedValue([activeLink(3000)]);

    await expect(
      repairLegacyAppliedCreditNoteAllocationsForBooking(
        "booking-1", "invoice-1", db as never,
      ),
    ).resolves.toBe(0);
  });

  it.each([
    ["decrease", 2000],
    ["increase", 4000],
  ])("reconciles a provider-observed manual %s without rewriting history", async (_label, target) => {
    db.memberCreditNoteAllocation.findMany.mockResolvedValue([slice(3000)]);
    db.xeroObjectLink.findMany.mockResolvedValue([activeLink(3000)]);

    await repairLegacyAppliedCreditNoteAllocationsForBooking(
      "booking-1",
      "invoice-1",
      db as never,
      { providerTarget: { xeroCreditNoteId: "cn-1", amountCents: target } },
    );

    expect(db.memberCreditNoteAllocation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { amountCents: target } }),
    );
    expect(db.xeroObjectLink.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["link-1"] } },
      data: { active: false },
    });
    expect(db.xeroObjectLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          xeroObjectId: `synthetic:cn-1:invoice-1:${target}:after:link-1`,
          metadata: expect.objectContaining({ rowTargetCents: target }),
        }),
      }),
    );
    expect(db.memberCredit.findMany).toHaveBeenCalledTimes(1);
  });

  it("fails closed when other slices leave too little of the funding lot", async () => {
    db.memberCreditNoteAllocation.aggregate.mockResolvedValue({
      _sum: { amountCents: 3000 },
    });

    await expect(
      repairLegacyAppliedCreditNoteAllocationsForBooking(
        "booking-1", "invoice-1", db as never,
      ),
    ).rejects.toThrow("exceeds remaining funding lot 2000c");
  });

  it("fails closed when the stamped note has ambiguous positive funding", async () => {
    db.memberCredit.findMany.mockReset();
    db.memberCredit.findMany
      .mockResolvedValueOnce(ledger())
      .mockResolvedValueOnce([
        { id: "lot-1", amountCents: 5000 },
        { id: "lot-2", amountCents: 5000 },
      ]);

    await expect(
      repairLegacyAppliedCreditNoteAllocationsForBooking(
        "booking-1", "invoice-1", db as never,
      ),
    ).rejects.toThrow("expected one positive funding lot, found 2");
  });
});
