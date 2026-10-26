/**
 * #4165: what the audit category filters' legacy action-name leg matched
 * BEFORE its prefixes became literal, and the rows that tell the two apart.
 *
 * `audit-query.ts`'s `actionStartsWith` and `actionContains` used to hand
 * Prisma a bare string, which PostgreSQL reads as `LIKE`, so each `_` matched
 * any one character. They now escape them (`exactPrefix`, `exactContains`). `unescapeLikeOperands`
 * rebuilds the old filter from the new one by stripping those escapes, so the
 * unit replay (`audit-legacy-filter-exact-prefix.test.ts`) and the PostgreSQL
 * proof (`audit-query-exact-prefix.realdb.test.ts`) compare the same two
 * shapes. The rebuilt filter also carries the `xero.` prefix #4165 named
 * explicitly; that matches a subset of what the wildcard `xero_` already did,
 * so it answers exactly as the pre-#4165 filter did.
 */
import type { AuditCategory } from "@/lib/audit-categories";

/** The same where object with every `startsWith` / `contains` backslash escape removed. */
export function unescapeLikeOperands<T>(where: T): T {
  if (Array.isArray(where)) return where.map((item) => unescapeLikeOperands(item)) as T;
  if (typeof where !== "object" || where === null || where instanceof Date) return where;
  return Object.fromEntries(
    Object.entries(where).map(([key, value]) => [
      key,
      (key === "startsWith" || key === "contains") && typeof value === "string"
        ? value.replace(/\\(.)/gs, "$1")
        : unescapeLikeOperands(value),
    ]),
  ) as T;
}

/**
 * An action no writer spells, which the OLD filter put in `category` only
 * through a wildcard `_` and the literal filter puts nowhere. One per prefix
 * or fragment that has a `_`, except `XERO_`: anything starting `XERO` also contains
 * `XERO`, which the same category matches anyway, so no decoy can separate
 * the two there.
 */
/**
 * The one legacy operand with a `_` that no decoy can separate (see above).
 * `audit-legacy-filter-exact-prefix.test.ts` requires a decoy for every other.
 */
export const LEGACY_FILTER_OPERANDS_WITHOUT_A_DECOY: readonly string[] = ["XERO_"];

export const LEGACY_FILTER_WILDCARD_DECOYS: readonly {
  action: string;
  oldCategories: readonly AuditCategory[];
}[] = [
  { action: "xeroXfoo", oldCategories: ["xero"] },
  { action: "MEMBERSHIPXAPPLICATIONXAPPROVED", oldCategories: ["account"] },
  { action: "membershipXcancellation.foo", oldCategories: ["account"] },
  { action: "EMAILSfoo", oldCategories: ["account"] },
  { action: "EMAILXCHANGED", oldCategories: ["account", "security"] },
  { action: "BOOKINGXfoo", oldCategories: ["booking"] },
  { action: "FAMILYXfoo", oldCategories: ["family"] },
  { action: "ADMINXfoo", oldCategories: ["admin"] },
  { action: "LODGEXfoo", oldCategories: ["lodge"] },
  { action: "memberXlifecycle.delete_requested", oldCategories: ["privacy"] },
  // The one `contains` fragment with a `_` (`actionContains("DATA_EXPORT")`).
  { action: "DATAXEXPORTfoo", oldCategories: ["privacy"] },
];

/**
 * Actions the audit-writer census cannot name as literals (a template, or a
 * constant it does not resolve) whose old match ran through a wildcard `_`:
 * the inbound reconcile's `xero.<type>.reconciled` (`xero-inbound/audit.ts`,
 * one per object type its summary switch names) and the #3792 refusal
 * (`xero-inbound/credit-note-repairs.ts`). Each writes `xero`, and each must
 * still answer to the `xero` filter.
 */
export const XERO_DOT_ACTIONS_THE_CENSUS_CANNOT_NAME: readonly string[] = [
  "xero.contact.reconciled",
  "xero.invoice.reconciled",
  "xero.subscription.reconciled",
  "xero.payment.reconciled",
  "xero.credit_note.reconciled",
  "xero.allocation.reconciled",
  "xero.allocation.restored-booking-change-refused",
];

/**
 * Written actions the PostgreSQL proof seeds beside the #2581 history: at
 * least one under every legacy prefix, and the `xero.` actions a writer spells
 * literally. The unit replay checks each is in the population it reads, so
 * this list cannot hold an action nothing writes.
 */
export const LEGACY_FILTER_PREFIX_WITNESSES: readonly string[] = [
  "member.profile.updated",
  "membership_cancellation.requested",
  "MEMBERSHIP_APPLICATION_APPROVED",
  "EMAIL_CHANGED",
  "EMAIL_CHANGE_REQUESTED",
  "EMAIL_TEMPLATE_OVERRIDE_UPDATED",
  "booking.created",
  "BOOKING_MESSAGE_OVERRIDE_UPDATED",
  "waitlist.offer_sent",
  "FAMILY_GROUP_CREATED",
  "family-group.login-holder-swapped",
  "ADMIN_NOTIFICATION_PREFERENCES_UPDATED",
  "LODGE_UPDATED",
  "XERO_PUSH",
  "xero_account_mappings_updated",
  "xero.operation.marked_failed",
  "xero.operation.marked_non_replayable",
  "xero.operation.manually_resolved",
  "xero.contact.synced_to_member",
  "xero.contact.moved_to_organisation",
  "member_lifecycle.delete_requested",
];
