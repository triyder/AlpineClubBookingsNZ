import { beforeEach, describe, expect, it, vi } from "vitest";

// E14 (#1944) part 2: audited manual mark-paid / mark-unpaid. These tests pin
// the status/provenance writes, the status-fenced (updateMany) guard rails, the
// owner-decided "no manual mark-paid once a Xero invoice links" semantic, the
// reversal status logic, and the invariant that NO Xero module is ever imported
// or called on this path.

const { prismaMock, auditMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    memberSubscription: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
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

function wireTransaction(
  subscriptionRow: Record<string, unknown> | null,
  options?: { fencedCount?: number },
) {
  const tx = {
    memberSubscription: {
      findUnique: vi.fn().mockResolvedValue(subscriptionRow),
      updateMany: vi.fn().mockResolvedValue({ count: options?.fencedCount ?? 1 }),
      findUniqueOrThrow: vi.fn().mockImplementation(async () => ({
        id: "sub-1",
        memberId: "m-1",
        seasonYear: 2026,
        status:
          tx.memberSubscription.updateMany.mock.calls[0]?.[0]?.data?.status ??
          subscriptionRow?.status,
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
    const args = tx.memberSubscription.updateMany.mock.calls[0][0];
    expect(args.data).toMatchObject({
      status: "PAID",
      manuallyMarkedPaidByMemberId: "admin-1",
      manualPaymentNote: "cash payment",
    });
    expect(args.data.manuallyMarkedPaidAt).toBeInstanceOf(Date);
    expect(args.data.paidAt).toBeInstanceOf(Date);
    // The write is status-fenced: every precondition is re-asserted atomically
    // inside the WHERE, so a concurrent double-mark or Xero sync loses the race
    // safely instead of double-applying (F4).
    expect(args.where).toMatchObject({
      id: "sub-1",
      status: { notIn: ["PAID", "NOT_REQUIRED"] },
      xeroInvoiceId: null,
      manuallyMarkedPaidAt: null,
    });
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

  it("rejects marking paid when a Xero invoice links — the payment belongs in Xero (owner-decided semantic)", async () => {
    const tx = wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "UNPAID",
      xeroInvoiceId: "inv-123", manuallyMarkedPaidAt: null,
    });

    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "sub-1", direction: "paid", actingMemberId: "admin-1" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("record the payment against the invoice in Xero"),
    });
    expect(tx.memberSubscription.updateMany).not.toHaveBeenCalled();
    expect(xeroCall).not.toHaveBeenCalled();
  });

  it("rejects marking a NOT_REQUIRED subscription paid — there is nothing to pay", async () => {
    const tx = wireTransaction({
      id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "NOT_REQUIRED",
      xeroInvoiceId: null, manuallyMarkedPaidAt: null,
    });

    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "sub-1", direction: "paid", actingMemberId: "admin-1" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.memberSubscription.updateMany).not.toHaveBeenCalled();
  });

  it("409s when the fenced mark-paid write matches no row (concurrent change)", async () => {
    wireTransaction(
      {
        id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "NOT_INVOICED",
        xeroInvoiceId: null, manuallyMarkedPaidAt: null,
      },
      { fencedCount: 0 },
    );

    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "sub-1", direction: "paid", actingMemberId: "admin-1" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(createAuditLog).not.toHaveBeenCalled();
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
    const args = tx.memberSubscription.updateMany.mock.calls[0][0];
    expect(args.data).toMatchObject({
      status: "NOT_INVOICED",
      paidAt: null,
      manuallyMarkedPaidAt: null,
      manuallyMarkedPaidByMemberId: null,
      manualPaymentNote: null,
    });
    // Reversal is fenced on the provenance column still being set (F4).
    expect(args.where).toMatchObject({
      id: "sub-1",
      manuallyMarkedPaidAt: { not: null },
    });
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership-subscription.manual-payment.mark-unpaid",
        metadata: expect.objectContaining({
          previousStatus: "PAID",
          restoredStatus: "NOT_INVOICED",
        }),
      }),
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
    expect(tx.memberSubscription.updateMany.mock.calls[0][0].data.status).toBe("UNPAID");
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

  it("409s when the fenced reversal write matches no row (provenance already cleared)", async () => {
    wireTransaction(
      {
        id: "sub-1", memberId: "m-1", seasonYear: 2026, status: "PAID",
        xeroInvoiceId: null, manuallyMarkedPaidAt: new Date("2026-05-01"),
      },
      { fencedCount: 0 },
    );

    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "sub-1", direction: "unpaid", actingMemberId: "admin-1" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("404s when the subscription does not exist", async () => {
    wireTransaction(null);
    await expect(
      applyManualSubscriptionPayment({ subscriptionId: "missing", direction: "paid", actingMemberId: "admin-1" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
