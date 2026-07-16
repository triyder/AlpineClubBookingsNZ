import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const memberCreditFindMany = vi.fn();
  const memberCreditCreate = vi.fn();
  const memberCreditUpdate = vi.fn();
  const memberCreditUpdateMany = vi.fn();
  const memberCreditAggregate = vi.fn();
  const allocationAggregate = vi.fn();
  const paymentFindUnique = vi.fn();
  const paymentUpdate = vi.fn();
  const operationFindMany = vi.fn();
  const linkFindMany = vi.fn();
  const repairPrecise = vi.fn();
  const lockLedger = vi.fn();
  const tx = {
    memberCredit: {
      findMany: memberCreditFindMany,
      create: memberCreditCreate,
      update: memberCreditUpdate,
      updateMany: memberCreditUpdateMany,
      aggregate: memberCreditAggregate,
    },
    memberCreditNoteAllocation: { aggregate: allocationAggregate },
    payment: { findUnique: paymentFindUnique, update: paymentUpdate },
    xeroSyncOperation: { findMany: operationFindMany },
  };
  const prisma = {
    payment: { findMany: vi.fn() },
    xeroObjectLink: { findMany: linkFindMany },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return {
    prisma,
    tx,
    memberCreditFindMany,
    memberCreditCreate,
    memberCreditUpdate,
    memberCreditUpdateMany,
    memberCreditAggregate,
    allocationAggregate,
    paymentFindUnique,
    paymentUpdate,
    operationFindMany,
    linkFindMany,
    repairPrecise,
    lockLedger,
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/member-credit", () => ({ lockMemberCreditLedger: h.lockLedger }));
vi.mock("@/lib/xero-applied-credit-allocation-repair", () => ({
  repairLegacyAppliedCreditNoteAllocationsForBooking: h.repairPrecise,
}));
vi.mock("@/lib/xero-inbound/object-links", () => ({
  findActiveXeroObjectLinks: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/xero-error-alert", () => ({ notifyXeroSyncError: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { repairAccountCreditAllocationBusinessState } from "@/lib/xero-inbound/credit-note-repairs";

describe("provider-aware inbound applied-credit repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.operationFindMany.mockResolvedValue([]);
    h.linkFindMany.mockResolvedValue([]);
    h.prisma.payment.findMany.mockResolvedValue([{
      id: "payment-1",
      bookingId: "booking-1",
      amountCents: 10000,
      creditAppliedCents: 3000,
      booking: { memberId: "member-1" },
    }]);
    h.memberCreditFindMany.mockResolvedValue([{
      id: "historical-negative",
      amountCents: -3000,
      description: "Applied to booking booking-",
      xeroCreditNoteId: "cn-1",
    }]);
    h.paymentFindUnique.mockResolvedValue({ creditAppliedCents: 3000 });
    h.memberCreditCreate.mockResolvedValue({});
    h.repairPrecise.mockResolvedValue(0);
  });

  it.each([
    ["decrease", 2000, 1000],
    ["increase", 4000, -1000],
  ])(
    "preserves historical rows and appends the provider manual %s delta",
    async (_label, targetCents, expectedOffsetCents) => {
      h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: targetCents } });
      h.memberCreditAggregate
        .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
        .mockResolvedValueOnce({ _sum: { amountCents: -3000 } })
        .mockResolvedValue({ _sum: { amountCents: -targetCents } });

      await repairAccountCreditAllocationBusinessState("cn-1", [{
        invoiceId: "invoice-1",
        amountCents: targetCents,
      }]);

      expect(h.repairPrecise).toHaveBeenCalledWith(
        "booking-1",
        "invoice-1",
        h.tx,
        {
          providerTarget: { xeroCreditNoteId: "cn-1", amountCents: targetCents },
        },
      );
      expect(h.memberCreditUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amountCents: expect.anything() }) }),
      );
      expect(h.memberCreditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amountCents: expectedOffsetCents,
          xeroCreditNoteId: "cn-1",
        }),
      });
      expect(h.paymentUpdate).toHaveBeenCalledWith({
        where: { id: "payment-1" },
        data: { creditAppliedCents: targetCents },
      });
      expect(h.lockLedger.mock.invocationCallOrder[0]).toBeLessThan(
        h.operationFindMany.mock.invocationCallOrder[0],
      );
      expect(h.operationFindMany.mock.invocationCallOrder[0]).toBeLessThan(
        h.repairPrecise.mock.invocationCallOrder[0],
      );
    },
  );

  it("defers stale inbound provider truth while a fresh clamp deallocation is pending", async () => {
    h.operationFindMany.mockResolvedValue([{
      id: "dealloc-pending",
      status: "PENDING",
      requestPayload: { queueType: "APPLIED_CREDIT_DEALLOCATION" },
    }]);

    await expect(
      repairAccountCreditAllocationBusinessState("cn-1", [{
        invoiceId: "invoice-1",
        amountCents: 3000,
      }]),
    ).rejects.toThrow("dealloc-pending is PENDING");
    expect(h.repairPrecise).not.toHaveBeenCalled();
    expect(h.memberCreditCreate).not.toHaveBeenCalled();
  });

  it("reconciles a manually deleted final provider allocation to zero from its active link", async () => {
    h.linkFindMany.mockResolvedValue([{
      metadata: { creditNoteId: "cn-1", invoiceId: "invoice-1", amountCents: 3000 },
    }]);
    h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    h.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
      .mockResolvedValueOnce({ _sum: { amountCents: -3000 } })
      .mockResolvedValue({ _sum: { amountCents: 0 } });

    await repairAccountCreditAllocationBusinessState("cn-1", []);

    expect(h.linkFindMany).toHaveBeenCalledWith({
      where: {
        xeroObjectType: "ALLOCATION",
        role: {
          in: [
            "APPLIED_CREDIT_ALLOCATION",
            "APPLIED_CREDIT_REMAINDER_ALLOCATION",
          ],
        },
        active: true,
        metadata: { path: ["creditNoteId"], equals: "cn-1" },
      },
      select: { metadata: true },
    });
    expect(h.repairPrecise).toHaveBeenCalledWith(
      "booking-1",
      "invoice-1",
      h.tx,
      {
        providerTarget: { xeroCreditNoteId: "cn-1", amountCents: 0 },
      },
    );
    expect(h.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amountCents: 3000,
        xeroCreditNoteId: "cn-1",
      }),
    });
    expect(h.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment-1" },
      data: { creditAppliedCents: 0 },
    });
  });

  it("is a no-op on replay: deleted-final-allocation reconciliation run twice appends no second offset row (#1887)", async () => {
    h.linkFindMany.mockResolvedValue([{
      metadata: { creditNoteId: "cn-1", invoiceId: "invoice-1", amountCents: 3000 },
    }]);

    // Run 1: the provider allocation was deleted (target 0) while a historical
    // -3000 applied row remains, so the reconciler appends a single +3000
    // offset to bring the signed ledger to provider truth (0).
    h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    h.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })     // unstamped (null cn)
      .mockResolvedValueOnce({ _sum: { amountCents: -3000 } }) // current ledger (pre-offset)
      .mockResolvedValue({ _sum: { amountCents: 0 } });        // post-offset total

    await repairAccountCreditAllocationBusinessState("cn-1", []);

    expect(h.memberCreditCreate).toHaveBeenCalledTimes(1);
    expect(h.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountCents: 3000, xeroCreditNoteId: "cn-1" }),
    });

    // Run 2 (replay): identical provider state, but the +3000 offset from run 1
    // now nets the signed ledger to zero. currentAppliedCents equals the
    // provider-aware applied total (0), so ledgerDeltaCents is 0 and NO new
    // MemberCredit offset row is appended — the reconciliation is idempotent.
    h.memberCreditCreate.mockClear();
    h.memberCreditUpdate.mockClear();
    h.memberCreditUpdateMany.mockClear();
    h.allocationAggregate.mockReset();
    h.memberCreditAggregate.mockReset();
    h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    h.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } }) // unstamped (offset is cn-1-stamped)
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } }) // current ledger already reconciled to 0
      .mockResolvedValue({ _sum: { amountCents: 0 } });    // post total
    // The replay now sees both the historical and reconciliation-offset rows.
    h.memberCreditFindMany.mockResolvedValue([
      { id: "historical-negative", amountCents: -3000, description: "Applied to booking booking-", xeroCreditNoteId: "cn-1" },
      { id: "reconciliation-offset", amountCents: 3000, description: "Applied to booking booking-", xeroCreditNoteId: "cn-1" },
    ]);

    await repairAccountCreditAllocationBusinessState("cn-1", []);

    expect(h.memberCreditCreate).not.toHaveBeenCalled();
  });
});
