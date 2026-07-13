import { beforeEach, describe, expect, it, vi } from "vitest";
import { Invoice } from "xero-node";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  subscriptionUpsert: vi.fn(),
  coverageFindMany: vi.fn(),
  getInvoice: vi.fn(),
  getInvoices: vi.fn(),
  getOnlineInvoice: vi.fn(),
  startOperation: vi.fn(),
  completeOperation: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique, findMany: mocks.memberFindMany },
    memberSubscription: {
      findUnique: mocks.subscriptionFindUnique,
      findFirst: mocks.subscriptionFindFirst,
      upsert: mocks.subscriptionUpsert,
    },
    membershipSubscriptionChargeCoverage: { findMany: mocks.coverageFindMany },
  },
}));
vi.mock("@/lib/member-subscription-eligibility", () => ({
  requiresPaidSubscriptionForAgeTierFromSettings: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/member-subscription-defaults", () => ({
  roleNeverRequiresSubscription: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/xero-api-client", () => ({
  XeroDailyLimitError: class XeroDailyLimitError extends Error {},
  getAuthenticatedXeroClient: vi.fn().mockResolvedValue({
    tenantId: "tenant-1",
    xero: {
      accountingApi: {
        getInvoice: mocks.getInvoice,
        getInvoices: mocks.getInvoices,
        getOnlineInvoice: mocks.getOnlineInvoice,
      },
    },
  }),
  callXeroApi: vi.fn(async (callback: () => Promise<unknown>) => callback()),
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: vi.fn().mockReturnValue("sync-key"),
  startXeroSyncOperation: mocks.startOperation,
  completeXeroSyncOperation: mocks.completeOperation,
  failXeroSyncOperation: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/xero-sync-cursors", () => ({
  getXeroSyncCursor: vi.fn().mockResolvedValue(null),
  getXeroSyncCursorMetadata: vi.fn().mockReturnValue({ retryMemberIds: [] }),
  parseXeroError: vi.fn((error: Error) => error.message),
  throttle: vi.fn().mockResolvedValue(undefined),
  upsertXeroSyncCursor: vi.fn().mockResolvedValue(undefined),
}));

import { checkMembershipStatus, refreshAllMembershipStatuses } from "@/lib/xero-membership-sync";

describe("membership charge reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberFindUnique.mockResolvedValue({
      id: "family-member-2",
      role: "USER",
      ageTier: "ADULT",
      xeroContactId: null,
    });
    mocks.subscriptionFindUnique.mockResolvedValue({
      id: "subscription-2",
      status: "UNPAID",
      xeroInvoiceId: "invoice-family",
      xeroInvoiceNumber: "INV-42",
      xeroOnlineInvoiceUrl: "https://in.xero.com/invoice-family",
      paidAt: null,
      chargeCoverage: {
        charge: { xeroInvoiceId: "invoice-family" },
      },
    });
    mocks.startOperation.mockResolvedValue({ id: "operation-1" });
    mocks.subscriptionUpsert.mockResolvedValue({ id: "subscription-2" });
    mocks.subscriptionFindFirst.mockResolvedValue({
      status: "UNPAID", xeroInvoiceId: "invoice-family", paidAt: null,
      xeroOnlineInvoiceUrl: "https://in.xero.com/invoice-family",
    });
    mocks.coverageFindMany.mockResolvedValue([]);
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.getOnlineInvoice.mockResolvedValue({ body: { onlineInvoices: [{ onlineInvoiceUrl: "https://in.xero.com/invoice-family" }] } });
    mocks.getInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "invoice-family",
            invoiceNumber: "INV-42",
            type: Invoice.TypeEnum.ACCREC,
            status: Invoice.StatusEnum.AUTHORISED,
            dueDate: new Date("2099-04-30T00:00:00.000Z"),
          },
        ],
      },
    });
  });

  it("refreshes a non-recipient family subscription by its immutable charge invoice", async () => {
    const result = await checkMembershipStatus("family-member-2", 2026);

    expect(result).toMatchObject({
      status: "UNPAID",
      xeroInvoiceId: "invoice-family",
    });
    expect(mocks.getInvoice).toHaveBeenCalledWith("tenant-1", "invoice-family");
    expect(mocks.getInvoices).not.toHaveBeenCalled();
    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "UNPAID",
          xeroInvoiceId: "invoice-family",
        }),
      })
    );
  });

  it("maps a changed shared paid invoice to every active covered family member", async () => {
    const members = [
      { id: "recipient", email: "recipient@example.test", firstName: "Bill", lastName: "Member", xeroContactId: "contact-1", updatedAt: new Date() },
      { id: "non-recipient", email: "child@example.test", firstName: "Child", lastName: "Member", xeroContactId: null, updatedAt: new Date() },
    ];
    mocks.getInvoices.mockResolvedValue({
      body: { invoices: [{
        invoiceID: "invoice-family",
        contact: { contactID: "contact-1" },
        status: Invoice.StatusEnum.PAID,
        type: Invoice.TypeEnum.ACCREC,
      }] },
    });
    mocks.coverageFindMany.mockResolvedValue(members.map((member) => ({
      charge: { xeroInvoiceId: "invoice-family" },
      subscription: { member },
    })));
    mocks.memberFindMany.mockResolvedValue(members);
    mocks.memberFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      ...members.find((member) => member.id === where.id),
      role: "USER",
      ageTier: "ADULT",
    }));
    mocks.subscriptionFindUnique.mockResolvedValue({
      id: "subscription-family",
      status: "UNPAID",
      xeroInvoiceId: "invoice-family",
      xeroInvoiceNumber: "INV-42",
      xeroOnlineInvoiceUrl: "https://in.xero.com/invoice-family",
      paidAt: null,
      chargeCoverage: { charge: { xeroInvoiceId: "invoice-family" } },
    });
    mocks.getInvoice.mockResolvedValue({
      body: { invoices: [{
        invoiceID: "invoice-family",
        invoiceNumber: "INV-42",
        type: Invoice.TypeEnum.ACCREC,
        status: Invoice.StatusEnum.PAID,
        fullyPaidOnDate: new Date("2026-07-14T00:00:00.000Z"),
      }] },
    });

    const result = await refreshAllMembershipStatuses(2026);

    expect(result).toMatchObject({ affectedMembers: 2, checked: 2, updated: 2, errors: 0 });
    expect(mocks.subscriptionUpsert).toHaveBeenCalledTimes(2);
    for (const member of members) {
      expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { memberId_seasonYear: { memberId: member.id, seasonYear: 2026 } },
        update: expect.objectContaining({ status: "PAID", xeroInvoiceId: "invoice-family" }),
      }));
    }
  });
});
