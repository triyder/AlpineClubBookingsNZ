// Shared type contracts for the Xero hardening subsystem (canonical-link
// reconciliation, repeated-failure alerts, reconciliation report, and
// historical backfill). Extracted verbatim from xero-hardening.ts as the
// type-only leaf of the #1208 item-5 split; the entry re-exports the public
// subset while the two shared private record types stay internal to the
// concern modules that consume them.

export interface CanonicalLinkExpectation {
  localModel: string;
  localId: string;
  role: string;
  xeroObjectType: string;
  xeroObjectId: string;
}

export type CanonicalLinkRecord = Pick<
  CanonicalLinkExpectation,
  "localModel" | "localId" | "role" | "xeroObjectType" | "xeroObjectId"
>;

export interface XeroRepeatedFailureSummary {
  correlationKey: string;
  failureCount: number;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  latestErrorMessage: string | null;
  latestOperationId: string;
  latestOperationStatus: string;
  latestOperationCreatedAt: Date;
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
}

export interface XeroUnsupportedPartialSummary {
  operationId: string;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
  reason: string;
  createdAt: Date;
}

export type XeroReconciliationIssueSeverity = "critical" | "warning" | "info";

export interface XeroReconciliationIssueItem {
  label: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
  operationId: string | null;
  operationStatus: string | null;
  operationType: string | null;
  correlationKey: string | null;
  detail: string | null;
  latestErrorMessage: string | null;
  createdAt: Date | null;
}

export interface XeroReconciliationIssueSection {
  id: string;
  title: string;
  severity: XeroReconciliationIssueSeverity;
  count: number;
  whatWentWrong: string;
  howToFix: string;
  items: XeroReconciliationIssueItem[];
}

export interface XeroReconciliationReport {
  generatedAt: Date;
  lookbackHours: number;
  stalePendingMinutes: number;
  summary: {
    missingMemberContactLinks: number;
    missingPaymentInvoiceLinks: number;
    missingPaymentRefundCreditNoteLinks: number;
    missingSubscriptionInvoiceLinks: number;
    mismatchedCanonicalLinks: number;
    staleCanonicalLinks: number;
    duplicateActiveCanonicalLinks: number;
    stalePendingOperations: number;
    recentFailedOperations: number;
    recentPartialOperations: number;
    unsupportedPartialOperations: number;
    repeatedFailureCorrelations: number;
    failedInboundEvents: number;
    issueCategoryCount: number;
    issueTotalCount: number;
  };
  issueSections: XeroReconciliationIssueSection[];
  repeatedFailures: XeroRepeatedFailureSummary[];
  unsupportedPartials: XeroUnsupportedPartialSummary[];
}

export interface XeroLinkBackfillCategoryResult {
  scanned: number;
  existingLinks: number;
  createdLinks: number;
  existingOperations: number;
  createdOperations: number;
}

export interface XeroHistoricalBackfillResult {
  completedAt: Date;
  members: XeroLinkBackfillCategoryResult;
  paymentInvoices: XeroLinkBackfillCategoryResult;
  paymentRefundCreditNotes: XeroLinkBackfillCategoryResult;
  subscriptionInvoices: XeroLinkBackfillCategoryResult;
  totals: {
    scanned: number;
    createdLinks: number;
    createdOperations: number;
  };
}

export interface XeroCanonicalLinkCleanupResult {
  completedAt: Date;
  scannedActiveLinks: number;
  keptActiveLinks: number;
  deactivatedLinks: number;
  byCategory: {
    memberContacts: number;
    paymentInvoices: number;
    paymentRefundCreditNotes: number;
    subscriptionInvoices: number;
    otherCanonicalLinks: number;
  };
  deactivatedLinkIds: string[];
}
