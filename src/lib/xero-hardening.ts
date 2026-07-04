// Entry module for the Xero hardening subsystem: canonical Xero object-link
// reconciliation/cleanup, repeated-failure alerting, the admin reconciliation
// report, and historical link backfill. #1208 item 5 split its ~1,700 lines of
// private helpers into cohesive xero-hardening-* sub-modules (a type-only leaf,
// a pure shared-helper leaf, and one module per concern); this module keeps the
// exact public surface by re-exporting it so external importers
// (xero-cron-runner, the admin link-maintenance route, xero-sync, and the
// tests) resolve unchanged. Import xero source modules directly, never the
// @/lib/xero facade (#1208). Values are re-exported with `export {}`; types with
// `export type {}` so no runtime function is erased.
export { cleanupStaleCanonicalXeroObjectLinks } from "./xero-hardening-canonical-links";
export { maybeNotifyXeroRepeatedFailure } from "./xero-hardening-repeated-failure";
export {
  // test seam
  buildXeroReconciliationReport,
  sendXeroReconciliationReport,
} from "./xero-hardening-report";
export { backfillHistoricalXeroObjectLinks } from "./xero-hardening-backfill";
export type {
  XeroCanonicalLinkCleanupResult,
  XeroHistoricalBackfillResult,
  XeroLinkBackfillCategoryResult,
  XeroReconciliationIssueItem,
  XeroReconciliationIssueSection,
  XeroReconciliationIssueSeverity,
  XeroReconciliationReport,
  XeroRepeatedFailureSummary,
  XeroUnsupportedPartialSummary,
} from "./xero-hardening-types";
