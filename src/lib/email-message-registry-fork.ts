/**
 * The fork's additions to the email message registry (fork #121).
 *
 * `email-message-registry.ts` is past upstream's hard size ceiling (#4926),
 * so a fork template's registry entries live here and the registry spreads
 * each table in place. Same shapes as the registry's own tables.
 */
import type { EmailAuditTemplateName } from "@/lib/email-message-audit-defaults";

/**
 * Admin and system templates. A food order goes to the Food Orders settings
 * address. Mutable, not delivery-locked: no money moves and every order stays
 * in the history.
 */
export const FORK_ADMIN_SYSTEM_TEMPLATE_NAMES: readonly EmailAuditTemplateName[] = [
  "food-order-placed",
];

/** An override that dropped the item list would send an empty order. */
export const FORK_REQUIRED_TEMPLATE_TOKENS: Partial<Record<EmailAuditTemplateName, string[]>> = {
  "food-order-placed": ["itemsText"],
};

export const FORK_TEMPLATE_TRIGGER_METADATA: Partial<
  Record<EmailAuditTemplateName, { triggerSummary: string; frequency: string }>
> = {
  "food-order-placed": {
    triggerSummary:
      "A member placed a food order for a lodge; sent to the food officer email in the Food Orders settings",
    frequency: "Per food order",
  },
};

/** The food-order email's tokens; none carries a bearer token or secret. */
export const FORK_APPROVED_EMAIL_TEMPLATE_TOKENS = [
  "officerLabel",
  "neededBy",
  "orderedBy",
  "itemsText",
  "notes",
  "foodOrderUrl",
] as const;
