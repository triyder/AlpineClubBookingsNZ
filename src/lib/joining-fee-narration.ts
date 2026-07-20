/**
 * The default joining-fee invoice-line narration (#1931, E5 — item 15).
 *
 * SHARED BY REFERENCE by both the Xero invoice line builder (its default
 * description) and the admin preview endpoint, so the preview can never drift
 * from what invoicing writes. It lives in its own module so tests can prove
 * that referential-reuse contract with a sentinel spy: mocking this module
 * intercepts BOTH callers' calls, whereas an intra-module call could not be
 * spied on.
 *
 * Display copy ONLY — never part of the frozen Xero reference or any
 * idempotency string (see docs/AUTHORITATIVE_FEES.md, "Frozen Xero
 * idempotency").
 */
export function buildJoiningFeeNarration(categoryLabel: string): string {
  return `Membership joining fee (${categoryLabel})`;
}
