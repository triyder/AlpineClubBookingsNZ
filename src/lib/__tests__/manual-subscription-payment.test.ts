import { beforeEach, describe, expect, it, vi } from "vitest";

// E14 (#1944) part 2: audited manual mark-paid / mark-unpaid. These tests pin
// the status/provenance writes, the reversal status logic, the guard rails, and
// the invariant that NO Xero module is ever imported or called on this path.

const { prismaMock, auditMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    memberSubscription: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  auditMock: { createAuditLog: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => auditMock);
vi.mock("server-only", () => ({}));

// If any Xero module were imported by the manual-payment path, these mocks would
// register; we assert they are never called.
const xeroCall = vi.fn();
vi.mock("@/lib/xero", () => new Proxy({}, { get: () => xeroCall }));
vi.mock("@/lib/xero-membership-sync", () => new Proxy({}, { get: () => xeroCall }));
vi.mock("@/lib/xero-subscription-invoices", () => new Proxy({}, { get: () => xeroCall }));

import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import {
  applyManualSubscriptionPayment,
  ManualSubscriptionPaymentError,
} from "@/lib/manual-subscription-payment";

function wireTransaction(subscriptionRow: unknown) {
  const tx = {
    memberSubscription: {
      findUnique: vi.fn().mockResolvedValue(subscriptionRow),
      update: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({
        id: "sub-1",
        memberId: "m-1",
        seasonYear: 2026,
        status: args.data.status,
      })),
    },
  };
  vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx));
  return tx;
}

describe("applyManualSubscriptionPayment (#1944)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xeroCall.mockReset();
  });

  it("marks a subscription paid with provenance and audits, without calling Xero", async () => {
    const tx = wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "NOT_INVOICED",
      xeroInvoiceId: null, manuallyMarkedPaidAt: null,
    });

    const result = await applyManualSubscriptionPayment({
      subscriptionId: "sub-1",
      direction: "paid",
      note: "  cash payment  ",
      actingMemberId: "admin-1",
    });

    expect(result).toMatchObject({ status: "PAID", direction: "paid" });
    const data = tx.memberSubscription.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: "PAID",
      manuallyMarkedPaidByMemberId: "admin-1",
      manualPaymentNote: "cash payment",
    });
    expect(data.manuallyMarkedPaidAt).toBeInstanceOf(Date);
    expect(data.paidAt).toBeInstanceOf(Date);
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership-subscription.manual-payment.mark-paid",
        memberId: "admin-1",
        subjectMemberId: "m-1",
      }),
      expect.anything(),
    );
    expect(xeroCall).not.toHaveBeenCalled();
  });

  it("rejects marking paid when the row is already PAID", async () => {
    wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "PAID",
      xeroInvoiceId: null, manuallyMarkedPaidAt: null,
    });

    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "sub-1", direction: "paid", actingMemberId: "admin-1" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(xeroCall).not.toHaveBeenCalled();
  });

  it("reversal restores NOT_INVOICED when there is no Xero invoice link and clears provenance", async () => {
    const tx = wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "PAID",
      xeroInvoiceId: null, manuallyMarkedPaidAt: new Date("2026-05-01"),
    });

    const result = await applyManualSubscriptionPayment({
      subscriptionId: "sub-1", direction: "unpaid", actingMemberId: "admin-1",
    });

    expect(result).toMatchObject({ status: "NOT_INVOICED", direction: "unpaid" });
    expect(tx.memberSubscription.update.mock.calls[0][0].data).toMatchObject({
      status: "NOT_INVOICED",
      paidAt: null,
      manuallyMarkedPaidAt: null,
      manuallyMarkedPaidByMemberId: null,
      manualPaymentNote: null,
    });
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "membership-subscription.manual-payment.mark-unpaid" }),
      expect.anything(),
    );
    expect(xeroCall).not.toHaveBeenCalled();
  });

  it("reversal restores UNPAID when a Xero invoice link exists", async () => {
    const tx = wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "PAID",
      xeroInvoiceId: "inv-123", manuallyMarkedPaidAt: new Date("2026-05-01"),
    });

    const result = await applyManualSubscriptionPayment({
      subscriptionId: "sub-1", direction: "unpaid", actingMemberId: "admin-1",
    });

    expect(result).toMatchObject({ status: "UNPAID" });
    expect(tx.memberSubscription.update.mock.calls[0][0].data.status).toBe("UNPAID");
  });

  it("rejects reversing a row that was not manually marked paid", async () => {
    wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "PAID",
      xeroInvoiceId: "inv-123", manuallyMarkedPaidAt: null,
    });

    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "sub-1", direction: "unpaid", actingMemberId: "admin-1" }),
    ).rejects.toBeInstanceOf(ManualSubscriptionPaymentError);
  });

  it("404s when the subscription does not exist", async () => {
    wireTransaction(null);
    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "missing", direction: "paid", actingMemberId: "admin-1" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
