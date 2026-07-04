import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  paymentFindMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
  linkFindMany: vi.fn(),
  linkCreateMany: vi.fn(),
  linkUpdateMany: vi.fn(),
  operationCount: vi.fn(),
  operationFindMany: vi.fn(),
  operationCreateMany: vi.fn(),
  inboundEventCount: vi.fn(),
  inboundEventFindMany: vi.fn(),
  emailFindFirst: vi.fn(),
  notificationDeliveryPolicyFindUnique: vi.fn(),
  sendRepeatedFailureAlert: vi.fn(),
  sendReconciliationReportAlert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findMany: mocks.memberFindMany,
    },
    payment: {
      findMany: mocks.paymentFindMany,
    },
    memberSubscription: {
      findMany: mocks.subscriptionFindMany,
    },
    xeroObjectLink: {
      findMany: mocks.linkFindMany,
      createMany: mocks.linkCreateMany,
      updateMany: mocks.linkUpdateMany,
    },
    xeroSyncOperation: {
      count: mocks.operationCount,
      findMany: mocks.operationFindMany,
      createMany: mocks.operationCreateMany,
    },
    xeroInboundEvent: {
      count: mocks.inboundEventCount,
      findMany: mocks.inboundEventFindMany,
    },
    emailLog: {
      findFirst: mocks.emailFindFirst,
    },
    notificationDeliveryPolicy: {
      findUnique: mocks.notificationDeliveryPolicyFindUnique,
    },
  },
}));

vi.mock("@/lib/email", () => ({
  sendAdminXeroRepeatedFailureAlert: mocks.sendRepeatedFailureAlert,
  sendAdminXeroReconciliationReportAlert: mocks.sendReconciliationReportAlert,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  backfillHistoricalXeroObjectLinks,
  buildXeroReconciliationReport,
  cleanupStaleCanonicalXeroObjectLinks,
  maybeNotifyXeroRepeatedFailure,
  sendXeroReconciliationReport,
} from "@/lib/xero-hardening";

describe("maybeNotifyXeroRepeatedFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operationCount.mockResolvedValue(3);
    mocks.emailFindFirst.mockResolvedValue(null);
    mocks.sendRepeatedFailureAlert.mockResolvedValue(undefined);
  });

  it("sends an alert once a correlation key has repeated failures", async () => {
    const result = await maybeNotifyXeroRepeatedFailure({
      id: "op_1",
      correlationKey: "payment:pay_1:invoice:v1",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "pay_1",
      lastErrorMessage: "Rate limit exceeded",
      xeroObjectType: "INVOICE",
      xeroObjectId: "inv_1",
      xeroObjectUrl: null,
    });

    expect(result).toEqual({
      triggered: true,
      failureCount: 3,
    });
    expect(mocks.sendRepeatedFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Repeated Xero Failure: payment:pay_1:invoice:v1",
        correlationKey: "payment:pay_1:invoice:v1",
        failureCount: 3,
        localUrl: "/admin/xero/records/Payment/pay_1",
      })
    );
  });

  it("suppresses alerts when one has already been sent in the current window", async () => {
    mocks.emailFindFirst.mockResolvedValue({ id: "email_1" });

    const result = await maybeNotifyXeroRepeatedFailure({
      id: "op_1",
      correlationKey: "payment:pay_1:invoice:v1",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "pay_1",
      lastErrorMessage: "Rate limit exceeded",
      xeroObjectType: "INVOICE",
      xeroObjectId: "inv_1",
      xeroObjectUrl: null,
    });

    expect(result).toEqual({
      triggered: false,
      failureCount: 3,
    });
    expect(mocks.sendRepeatedFailureAlert).not.toHaveBeenCalled();
  });
});

describe("buildXeroReconciliationReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inboundEventCount.mockResolvedValue(0);
    mocks.inboundEventFindMany.mockResolvedValue([]);
  });

  it("summarises canonical drift, repeated failures, and unsupported partials", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "mem_1", xeroContactId: "contact_1" },
    ]);
    mocks.paymentFindMany.mockResolvedValue([
      { id: "pay_1", xeroInvoiceId: "inv_1", xeroRefundCreditNoteId: "cn_1" },
    ]);
    mocks.subscriptionFindMany.mockResolvedValue([
      { id: "sub_1", xeroInvoiceId: "subinv_1" },
    ]);
    mocks.linkFindMany.mockResolvedValue([
      {
        localModel: "Member",
        localId: "mem_1",
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact_1",
        role: "CONTACT",
      },
      {
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_old",
        role: "PRIMARY_INVOICE",
      },
      {
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectId: "cn_1",
        xeroObjectType: "CREDIT_NOTE",
        role: "REFUND_CREDIT_NOTE",
      },
      {
        localModel: "MemberSubscription",
        localId: "sub_1",
        xeroObjectType: "SUBSCRIPTION",
        xeroObjectId: "subinv_1",
        role: "SUBSCRIPTION_INVOICE",
      },
      {
        localModel: "MemberSubscription",
        localId: "sub_1",
        xeroObjectType: "SUBSCRIPTION",
        xeroObjectId: "subinv_old",
        role: "SUBSCRIPTION_INVOICE",
      },
    ]);
    mocks.operationFindMany.mockResolvedValueOnce([
      {
        id: "op_4",
        direction: "OUTBOUND",
        correlationKey: "contact:mem_1:repair-gap:v1",
        entityType: "CONTACT",
        operationType: "CREATE",
        localModel: "Member",
        localId: "mem_1",
        lastErrorMessage: "Manual repair needed",
        replayable: true,
        requestPayload: null,
        responsePayload: null,
        status: "PARTIAL",
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact_1",
        createdAt: new Date("2026-04-13T10:15:00Z"),
        startedAt: null,
        xeroObjectNumber: null,
        xeroObjectUrl: null,
      },
      {
        id: "op_3",
        direction: "OUTBOUND",
        correlationKey: "payment:pay_1:invoice:v1",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        lastErrorMessage: "Timeout",
        replayable: true,
        requestPayload: null,
        responsePayload: null,
        status: "FAILED",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_1",
        createdAt: new Date("2026-04-13T10:10:00Z"),
        startedAt: null,
        xeroObjectNumber: "INV-001",
        xeroObjectUrl: null,
      },
      {
        id: "op_2",
        direction: "OUTBOUND",
        correlationKey: "payment:pay_1:invoice:v1",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        lastErrorMessage: "Timeout",
        replayable: true,
        requestPayload: null,
        responsePayload: {
          invoice: {
            invoices: [{ total: 45.67 }],
          },
        },
        status: "PARTIAL",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_1",
        createdAt: new Date("2026-04-13T10:00:00Z"),
        startedAt: null,
        xeroObjectNumber: "INV-001",
        xeroObjectUrl: null,
      },
      {
        id: "op_1",
        direction: "OUTBOUND",
        correlationKey: "payment:pay_1:invoice:v1",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        lastErrorMessage: "Timeout",
        replayable: true,
        requestPayload: null,
        responsePayload: null,
        status: "FAILED",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_1",
        createdAt: new Date("2026-04-13T09:55:00Z"),
        startedAt: null,
        xeroObjectNumber: "INV-001",
        xeroObjectUrl: null,
      },
    ]);
    mocks.operationCount.mockResolvedValue(2);
    mocks.operationFindMany.mockResolvedValueOnce([
      {
        id: "op_pending_1",
        direction: "OUTBOUND",
        correlationKey: "payment:pay_1:invoice:v1",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        status: "PENDING",
        lastErrorMessage: null,
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_1",
        xeroObjectNumber: "INV-001",
        xeroObjectUrl: null,
        startedAt: null,
        createdAt: new Date("2026-04-13T11:00:00Z"),
      },
    ]);

    const report = await buildXeroReconciliationReport({
      now: new Date("2026-04-13T12:00:00Z"),
    });

    expect(report.summary).toEqual({
      missingMemberContactLinks: 0,
      missingPaymentInvoiceLinks: 1,
      missingPaymentRefundCreditNoteLinks: 0,
      missingSubscriptionInvoiceLinks: 0,
      mismatchedCanonicalLinks: 1,
      staleCanonicalLinks: 2,
      duplicateActiveCanonicalLinks: 1,
      stalePendingOperations: 2,
      recentFailedOperations: 2,
      recentPartialOperations: 2,
      unsupportedPartialOperations: 1,
      repeatedFailureCorrelations: 1,
      failedInboundEvents: 0,
      issueCategoryCount: 9,
      issueTotalCount: 13,
    });
    expect(report.repeatedFailures).toEqual([
      expect.objectContaining({
        correlationKey: "payment:pay_1:invoice:v1",
        failureCount: 3,
        localUrl: "/admin/xero/records/Payment/pay_1",
        latestOperationId: "op_3",
        xeroObjectUrl: "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv_1",
      }),
    ]);
    expect(report.unsupportedPartials).toEqual([
      expect.objectContaining({
        operationId: "op_4",
        localUrl: "/admin/members/mem_1",
        xeroObjectUrl: "https://go.xero.com/Contacts/View/contact_1",
        reason: "This partial Xero operation does not have a repair handler yet.",
      }),
    ]);
    expect(report.issueSections).toEqual([
      expect.objectContaining({
        id: "unsupported-partials",
        severity: "critical",
        count: 1,
        items: [
          expect.objectContaining({
            operationId: "op_4",
            localUrl: "/admin/members/mem_1",
          }),
        ],
      }),
      expect.objectContaining({
        id: "repeated-failures",
        severity: "critical",
        count: 1,
        items: [
          expect.objectContaining({
            operationId: "op_3",
            latestErrorMessage: "Timeout",
          }),
        ],
      }),
      expect.objectContaining({
        id: "stale-pending-operations",
        severity: "warning",
        count: 2,
        items: [
          expect.objectContaining({
            operationId: "op_pending_1",
            operationStatus: "PENDING",
          }),
        ],
      }),
      expect.objectContaining({
        id: "canonical-link-drift",
        severity: "warning",
        count: 5,
      }),
      expect.objectContaining({
        id: "recent-failed-partial-operations",
        severity: "info",
        count: 4,
      }),
    ]);
  });
});

describe("buildXeroReconciliationReport persistently failing inbound events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.operationFindMany.mockResolvedValue([]);
    mocks.operationCount.mockResolvedValue(0);
    mocks.inboundEventCount.mockResolvedValue(0);
    mocks.inboundEventFindMany.mockResolvedValue([]);
  });

  it("surfaces FAILED inbound events older than the age threshold, with redacted errors", async () => {
    mocks.inboundEventCount.mockResolvedValue(1);
    mocks.inboundEventFindMany.mockResolvedValue([
      {
        id: "inbound_1",
        correlationKey: "xero-webhook:INVOICE:inv_stuck_1:UPDATE",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_stuck_1",
        errorMessage: "Payload rejected: access_token=abcSECRET123 could not be parsed",
        createdAt: new Date("2026-04-13T09:00:00Z"),
      },
    ]);

    const report = await buildXeroReconciliationReport({
      now: new Date("2026-04-13T12:00:00Z"),
    });

    expect(report.summary.failedInboundEvents).toBe(1);
    // Only the inbound section contributes issues here, so the counters are 1/1.
    expect(report.summary.issueCategoryCount).toBe(1);
    expect(report.summary.issueTotalCount).toBe(1);

    // Query is age-filtered at the DB layer: only events created before the
    // now-minus-60-minute cutoff are counted / sampled.
    expect(mocks.inboundEventCount).toHaveBeenCalledWith({
      where: {
        status: "FAILED",
        createdAt: { lt: new Date("2026-04-13T11:00:00Z") },
      },
    });
    expect(mocks.inboundEventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "FAILED",
          createdAt: { lt: new Date("2026-04-13T11:00:00Z") },
        },
        orderBy: { createdAt: "asc" },
        take: 5,
      })
    );

    const inboundSection = report.issueSections.find(
      (section) => section.id === "failed-inbound-events"
    );
    expect(inboundSection).toMatchObject({
      id: "failed-inbound-events",
      severity: "critical",
      count: 1,
    });
    expect(inboundSection?.items).toHaveLength(1);

    const item = inboundSection?.items[0];
    expect(item).toMatchObject({
      operationId: "inbound_1",
      operationStatus: "FAILED",
      correlationKey: "xero-webhook:INVOICE:inv_stuck_1:UPDATE",
    });
    expect(item?.detail).toContain("3 hours");
    // errorMessage is redacted before it reaches the report/email.
    expect(item?.latestErrorMessage).toBe(
      "Payload rejected: access_token=[REDACTED] could not be parsed"
    );
    expect(item?.latestErrorMessage).not.toContain("abcSECRET123");
  });

  it("excludes inbound events newer than the default age threshold via the query cutoff", async () => {
    // A fresh FAILED event (younger than the 60-minute threshold) is filtered
    // out at the DB layer, so count is 0 and no section is emitted.
    mocks.inboundEventCount.mockResolvedValue(0);
    mocks.inboundEventFindMany.mockResolvedValue([]);

    const report = await buildXeroReconciliationReport({
      now: new Date("2026-04-13T12:00:00Z"),
    });

    expect(report.summary.failedInboundEvents).toBe(0);
    expect(
      report.issueSections.some((section) => section.id === "failed-inbound-events")
    ).toBe(false);
    expect(mocks.inboundEventCount).toHaveBeenCalledWith({
      where: {
        status: "FAILED",
        createdAt: { lt: new Date("2026-04-13T11:00:00Z") },
      },
    });
  });

  it("honours a custom failedInboundMinAgeMinutes threshold", async () => {
    await buildXeroReconciliationReport({
      now: new Date("2026-04-13T12:00:00Z"),
      failedInboundMinAgeMinutes: 120,
    });

    expect(mocks.inboundEventCount).toHaveBeenCalledWith({
      where: {
        status: "FAILED",
        createdAt: { lt: new Date("2026-04-13T10:00:00Z") },
      },
    });
  });
});

describe("sendXeroReconciliationReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.operationFindMany.mockResolvedValue([]);
    mocks.operationCount.mockResolvedValue(0);
    mocks.inboundEventCount.mockResolvedValue(0);
    mocks.inboundEventFindMany.mockResolvedValue([]);
    mocks.notificationDeliveryPolicyFindUnique.mockResolvedValue(null);
    mocks.sendReconciliationReportAlert.mockResolvedValue(undefined);
  });

  it("does not email clean reports under the default content-only policy", async () => {
    const result = await sendXeroReconciliationReport({
      now: new Date("2026-04-13T12:00:00Z"),
    });

    expect(result.sent).toBe(false);
    expect(result.deliveryMode).toBe("content_only");
    expect(result.skippedReason).toBe("no_content");
    expect(mocks.sendReconciliationReportAlert).not.toHaveBeenCalled();
  });

  it("emails reports with issues under the default content-only policy", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "mem_1", xeroContactId: "contact_1" },
    ]);

    const result = await sendXeroReconciliationReport({
      now: new Date("2026-04-13T12:00:00Z"),
    });

    expect(result.sent).toBe(true);
    expect(result.deliveryMode).toBe("content_only");
    expect(result.report.summary.issueTotalCount).toBeGreaterThan(0);
    expect(mocks.sendReconciliationReportAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({
          issueTotalCount: expect.any(Number),
        }),
      }),
    );
  });

  it("emails clean reports when policy is always", async () => {
    mocks.notificationDeliveryPolicyFindUnique.mockResolvedValue({
      templateName: "admin-xero-reconciliation-report",
      mode: "ALWAYS",
    });

    const result = await sendXeroReconciliationReport({
      now: new Date("2026-04-13T12:00:00Z"),
    });

    expect(result.sent).toBe(true);
    expect(result.deliveryMode).toBe("always");
    expect(mocks.sendReconciliationReportAlert).toHaveBeenCalled();
  });

  it("does not email reports with issues when policy is disabled", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "mem_1", xeroContactId: "contact_1" },
    ]);
    mocks.notificationDeliveryPolicyFindUnique.mockResolvedValue({
      templateName: "admin-xero-reconciliation-report",
      mode: "DISABLED",
    });

    const result = await sendXeroReconciliationReport({
      now: new Date("2026-04-13T12:00:00Z"),
    });

    expect(result.sent).toBe(false);
    expect(result.deliveryMode).toBe("disabled");
    expect(result.skippedReason).toBe("disabled");
    expect(result.report.summary.issueTotalCount).toBeGreaterThan(0);
    expect(mocks.sendReconciliationReportAlert).not.toHaveBeenCalled();
  });
});

describe("backfillHistoricalXeroObjectLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.operationFindMany.mockResolvedValue([]);
    mocks.linkCreateMany.mockResolvedValue({ count: 1 });
    mocks.operationCreateMany.mockResolvedValue({ count: 1 });
  });

  it("creates missing canonical links and synthetic backfill ledger rows", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "mem_1", xeroContactId: "contact_1" },
    ]);
    mocks.paymentFindMany.mockResolvedValue([
      {
        id: "pay_1",
        xeroInvoiceId: "inv_1",
        xeroInvoiceNumber: "INV-001",
        xeroRefundCreditNoteId: "cn_1",
      },
    ]);
    mocks.subscriptionFindMany.mockResolvedValue([
      {
        id: "sub_1",
        seasonYear: 2026,
        xeroInvoiceId: "subinv_1",
        xeroInvoiceNumber: "SUB-001",
        xeroOnlineInvoiceUrl: "https://pay.xero.com/subinv_1",
      },
    ]);

    const result = await backfillHistoricalXeroObjectLinks();

    expect(result.totals).toEqual({
      scanned: 4,
      createdLinks: 4,
      createdOperations: 4,
    });
    expect(mocks.linkCreateMany).toHaveBeenCalledTimes(4);
    expect(mocks.operationCreateMany).toHaveBeenCalledTimes(4);
    expect(mocks.linkCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            localModel: "Member",
            localId: "mem_1",
            role: "CONTACT",
          }),
        ]),
      })
    );
    expect(mocks.operationCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            operationType: "BACKFILL_LINK",
            localModel: "Member",
            localId: "mem_1",
            status: "SUCCEEDED",
          }),
        ]),
      })
    );
  });
});

describe("cleanupStaleCanonicalXeroObjectLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.linkUpdateMany.mockResolvedValue({ count: 2 });
  });

  it("deactivates active canonical links that no longer match the local canonical fields", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "mem_1", xeroContactId: "contact_new" },
    ]);
    mocks.paymentFindMany.mockResolvedValue([
      {
        id: "pay_1",
        xeroInvoiceId: "inv_1",
        xeroRefundCreditNoteId: null,
      },
    ]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.linkFindMany.mockResolvedValue([
      {
        id: "link_keep_contact",
        localModel: "Member",
        localId: "mem_1",
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact_new",
        role: "CONTACT",
      },
      {
        id: "link_old_contact",
        localModel: "Member",
        localId: "mem_1",
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact_old",
        role: "CONTACT",
      },
      {
        id: "link_old_invoice",
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_old",
        role: "PRIMARY_INVOICE",
      },
    ]);

    const result = await cleanupStaleCanonicalXeroObjectLinks();

    expect(result).toEqual({
      completedAt: expect.any(Date),
      scannedActiveLinks: 3,
      keptActiveLinks: 1,
      deactivatedLinks: 2,
      byCategory: {
        memberContacts: 1,
        paymentInvoices: 1,
        paymentRefundCreditNotes: 0,
        subscriptionInvoices: 0,
        otherCanonicalLinks: 0,
      },
      deactivatedLinkIds: ["link_old_contact", "link_old_invoice"],
    });
    expect(mocks.linkUpdateMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: ["link_old_contact", "link_old_invoice"],
        },
        active: true,
      },
      data: {
        active: false,
      },
    });
  });
});
