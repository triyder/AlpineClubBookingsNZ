// F21 (#1886): the entrance-fee invoice worker must never mint a second
// invoice for the same member. The enqueue-time guard only blocks when a link
// ALREADY exists, and its PENDING/RUNNING dedupe is keyed on amount + category,
// so a second enqueue carrying a different amount override (or a reclassified
// category) slips past both. The worker therefore re-checks the durable
// ENTRANCE_FEE_INVOICE link and, failing that, adopts a prior mint found in
// Xero by reference — rather than creating a duplicate.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    entranceFee: { findFirst: vi.fn().mockResolvedValue(null) },
    member: { findUnique: vi.fn() },
    familyGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
    xeroItemCodeMapping: { findFirst: vi.fn() },
    xeroAccountMapping: { findUnique: vi.fn() },
    xeroObjectLink: { findFirst: vi.fn() },
    xeroSyncOperation: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

const mockCompleteXeroSyncOperation = vi.fn();
const mockStartXeroSyncOperation = vi.fn();
vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    completeXeroSyncOperation: (...args: unknown[]) =>
      mockCompleteXeroSyncOperation(...args),
    startXeroSyncOperation: (...args: unknown[]) =>
      mockStartXeroSyncOperation(...args),
    failXeroSyncOperation: vi.fn(),
  };
});

// Adopt-by-reference reads Xero; the durable-link case must never reach it, so
// default to rejecting and let the reference test override per-call.
const mockGetAuthenticatedXeroClient = vi.fn();
vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-api-client")>();
  return {
    ...actual,
    // Run the wrapped call directly; the real wrapper persists metered usage to
    // prisma, which is not modelled in this unit test.
    callXeroApi: (fn: () => unknown) => fn(),
    getAuthenticatedXeroClient: (...args: unknown[]) =>
      mockGetAuthenticatedXeroClient(...args),
  };
});

vi.mock("@/lib/xero-mappings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-mappings")>();
  return {
    ...actual,
    getResolvedAccountMapping: vi
      .fn()
      .mockResolvedValue({ code: "200", codeExplicitlyConfigured: false }),
  };
});

const mockFindOrCreateXeroContact = vi.fn();
const mockRetryXeroWriteWithContactRepair = vi.fn();
vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: (...args: unknown[]) =>
    mockFindOrCreateXeroContact(...args),
  retryXeroWriteWithContactRepair: (...args: unknown[]) =>
    mockRetryXeroWriteWithContactRepair(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { createXeroEntranceFeeInvoice } from "@/lib/xero-entrance-fee-invoices";

const ADULT_FEE = {
  category: "ADULT" as const,
  feeMapping: { itemCode: null, amountCents: 10000 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.familyGroupMember.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.member.findUnique).mockResolvedValue({
    ageTier: "ADULT",
  } as never);
  vi.mocked(prisma.xeroSyncOperation.update).mockResolvedValue({} as never);
  mockGetAuthenticatedXeroClient.mockRejectedValue(
    new Error("Xero must not be reached in the durable-link case"),
  );
});

describe("createXeroEntranceFeeInvoice double-mint guard (F21)", () => {
  it("adopts the already-linked invoice instead of minting a second (durable-link re-check)", async () => {
    // First mint already wrote the ENTRANCE_FEE_INVOICE link. A second worker
    // run (e.g. an amount-override re-enqueue with a fresh correlation key)
    // must adopt it, not mint again.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue({
      xeroObjectId: "inv-existing",
      xeroObjectNumber: "INV-001",
      xeroObjectUrl: "https://xero/inv-existing",
    } as never);

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-second",
      precomputedEntranceFee: ADULT_FEE,
    });

    expect(result).toBe("inv-existing");
    // No mint, and Xero was never even contacted.
    expect(mockRetryXeroWriteWithContactRepair).not.toHaveBeenCalled();
    expect(mockGetAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith("op-second", {
      responsePayload: expect.objectContaining({ adopted: true }),
      xeroObjectType: "INVOICE",
      xeroObjectId: "inv-existing",
      xeroObjectNumber: "INV-001",
      xeroObjectUrl: "https://xero/inv-existing",
    });
  });

  it("adopts a prior mint found in Xero by reference when no link exists yet", async () => {
    // The link write crashed after the first mint, so no durable link exists,
    // but Xero already holds the invoice under its stable reference.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");

    const getInvoices = vi.fn().mockResolvedValue({
      body: {
        invoices: [{ invoiceID: "inv-xero", invoiceNumber: "INV-XERO" }],
      },
    });
    const createInvoices = vi.fn();
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices } },
      tenantId: "tenant-1",
    });

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-second",
      precomputedEntranceFee: ADULT_FEE,
    });

    expect(result).toBe("inv-xero");
    // Looked the reference up, found one, and did NOT mint a second.
    expect(getInvoices).toHaveBeenCalledTimes(1);
    expect(getInvoices).toHaveBeenCalledWith(
      "tenant-1",
      undefined,
      'Reference=="Entrance fee (Adult) - member-1"',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      false,
    );
    expect(createInvoices).not.toHaveBeenCalled();
    expect(mockRetryXeroWriteWithContactRepair).not.toHaveBeenCalled();
    // Adoption backfills the durable ENTRANCE_FEE_INVOICE link.
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith(
      "op-second",
      expect.objectContaining({
        xeroObjectId: "inv-xero",
        extraLinks: expect.arrayContaining([
          expect.objectContaining({
            role: "ENTRANCE_FEE_INVOICE",
            xeroObjectId: "inv-xero",
            localModel: "Member",
            localId: "member-1",
          }),
        ]),
      }),
    );
  });

  it("mints exactly once when no link and no prior Xero invoice exist", async () => {
    // Baseline: the guards must not block the legitimate first mint.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");

    const getInvoices = vi.fn().mockResolvedValue({ body: { invoices: [] } });
    const createInvoices = vi.fn();
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices } },
      tenantId: "tenant-1",
    });
    mockRetryXeroWriteWithContactRepair.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-new", invoiceNumber: "INV-NEW" }] },
    });

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-first",
      precomputedEntranceFee: ADULT_FEE,
    });

    expect(result).toBe("inv-new");
    expect(getInvoices).toHaveBeenCalledTimes(1);
    expect(mockRetryXeroWriteWithContactRepair).toHaveBeenCalledTimes(1);
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith(
      "op-first",
      expect.objectContaining({ xeroObjectId: "inv-new" }),
    );
  });
});
