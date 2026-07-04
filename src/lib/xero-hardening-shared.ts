// Cross-concern constants and pure helpers shared by more than one Xero
// hardening concern module: repeated-failure + report share the failure-window
// math and the REQUEUE/threshold constants; canonical-links + report share the
// canonical scope-key builder. Extracted verbatim from xero-hardening.ts as a
// pure leaf of the #1208 item-5 split (no imports, no side effects).

export const XERO_REQUEUE_OPERATION_TYPE = "REQUEUE";

export const DEFAULT_REPEATED_FAILURE_THRESHOLD = 3;

export function getRepeatedFailureWindowStart(now: Date, windowHours: number) {
  return new Date(now.getTime() - windowHours * 60 * 60 * 1000);
}

export function buildCanonicalScopeKey(target: {
  localModel: string;
  localId: string;
  role: string;
}) {
  return [target.localModel, target.localId, target.role].join(":");
}
