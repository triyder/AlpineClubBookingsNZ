// Owner decision (2026-07-07, #1440 follow-up): organisations/schools — the
// NOT_APPLICABLE age tier — are exempt from entrance fees. Every invoice
// path must skip, including explicit amount overrides and queued operations
// replayed after a member became an organisation.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    entranceFee: { findFirst: vi.fn().mockResolvedValue(null) },
    member: { findUnique: vi.fn() },
    familyGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
    xeroItemCodeMapping: { findFirst: vi.fn() },
    xeroAccountMapping: { findUnique: vi.fn() },
    xeroObjectLink: { findFirst: vi.fn() },
    xeroSyncOperation: { findFirst: vi.fn() },
  },
}));

const mockCompleteXeroSyncOperation = vi.fn();
vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    completeXeroSyncOperation: (...args: unknown[]) =>
      mockCompleteXeroSyncOperation(...args),
    startXeroSyncOperation: vi.fn(),
  };
});

vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-api-client")>();
  return {
    ...actual,
    getAuthenticatedXeroClient: vi.fn().mockRejectedValue(
      new Error("must not reach Xero in these tests"),
    ),
  };
});

vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: vi.fn(),
  retryXeroWriteWithContactRepair: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import {
  ENTRANCE_FEE_EXEMPT_MESSAGE,
  getEntranceFeeContext,
} from "@/lib/xero-mappings";
import { createXeroEntranceFeeInvoice } from "@/lib/xero-entrance-fee-invoices";
import { enqueueXeroEntranceFeeInvoiceOperation } from "@/lib/xero-operation-outbox";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.familyGroupMember.findMany).mockResolvedValue([] as never);
});

describe("getEntranceFeeContext for NOT_APPLICABLE members", () => {
  it("marks organisations exempt without looking up a fee mapping", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ageTier: "NOT_APPLICABLE",
    } as never);

    const context = await getEntranceFeeContext("org1");

    expect(context.exempt).toBe(true);
    expect(context.feeMapping).toEqual({ itemCode: null, amountCents: null });
    expect(prisma.xeroItemCodeMapping.findFirst).not.toHaveBeenCalled();
  });

  it("leaves person members non-exempt", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ageTier: "ADULT",
    } as never);
    vi.mocked(prisma.xeroItemCodeMapping.findFirst).mockResolvedValue({
      itemCode: "ENTRANCE",
      amountCents: 10000,
    } as never);

    const context = await getEntranceFeeContext("m1");

    expect(context.exempt).toBeUndefined();
    expect(context.category).toBe("ADULT");
    expect(context.feeMapping.amountCents).toBe(10000);
  });
});

describe("enqueueXeroEntranceFeeInvoiceOperation exemption", () => {
  it("refuses to queue for an organisation even with an explicit amount override", async () => {
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ageTier: "NOT_APPLICABLE",
    } as never);

    const result = await enqueueXeroEntranceFeeInvoiceOperation("org1", {
      amountCents: 12345,
    });

    expect(result.queueOperationId).toBeNull();
    expect(result.message).toBe(ENTRANCE_FEE_EXEMPT_MESSAGE);
    expect(prisma.xeroSyncOperation.findFirst).not.toHaveBeenCalled();
  });
});

describe("createXeroEntranceFeeInvoice exemption", () => {
  it("skips and completes the queued operation with the exempt reason", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ageTier: "NOT_APPLICABLE",
    } as never);

    const result = await createXeroEntranceFeeInvoice("org1", {
      syncOperationId: "op-1",
    });

    expect(result).toBeNull();
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith("op-1", {
      status: "SUCCEEDED",
      responsePayload: expect.objectContaining({
        skipped: true,
        reason: ENTRANCE_FEE_EXEMPT_MESSAGE,
      }),
    });
  });

  it("skips a replayed operation whose precomputed context predates the org reclassification", async () => {
    // The stored payload says ADULT/$100 (queued before the member became an
    // organisation); the fresh tier read must still exempt it.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ageTier: "NOT_APPLICABLE",
    } as never);

    const result = await createXeroEntranceFeeInvoice("org1", {
      syncOperationId: "op-2",
      precomputedEntranceFee: {
        category: "ADULT",
        feeMapping: { itemCode: "ENTRANCE", amountCents: 10000 },
      },
    });

    expect(result).toBeNull();
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith("op-2", {
      status: "SUCCEEDED",
      responsePayload: expect.objectContaining({
        skipped: true,
        reason: ENTRANCE_FEE_EXEMPT_MESSAGE,
      }),
    });
  });
});
