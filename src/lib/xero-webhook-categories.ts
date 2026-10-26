/**
 * Xero webhook `eventCategory` values, and the spellings this app stores.
 *
 * Xero's Webhooks OpenAPI (eventCategory) sends credit notes as `CREDITNOTE`
 * — no underscore — alongside `CONTACT`, `INVOICE`, `SUBSCRIPTION`,
 * `PREPAYMENT`, and `OVERPAYMENT`. A credit-note payload also carries
 * `data.Status`, which includes `VOIDED`. This app's own object type is
 * `CREDIT_NOTE`. Both spellings name that document: the wire value is what a
 * webhook stores, and the underscored value is what older rows and the local
 * link type use.
 *
 * Subscriptions are chosen in the Xero developer portal (My Apps → the app →
 * Webhooks). This app does not register them. Operators must tick Invoices,
 * Contacts, and Credit Notes.
 */

const CREDIT_NOTE_EVENT_CATEGORIES = ["CREDITNOTE", "CREDIT_NOTE"] as const;

/** Category values on the Inbound Events filter. `CREDITNOTE` is Xero's wire value. */
export const XERO_INBOUND_EVENT_CATEGORY_FILTERS = [
  "all",
  "CONTACT",
  "INVOICE",
  "PAYMENT",
  "CREDITNOTE",
] as const;

/**
 * The category the inbound reconciler switches on. `CREDIT_NOTE` collapses to
 * Xero's `CREDITNOTE` so a stored row in either spelling takes the credit-note
 * path. Any other non-empty category is returned trimmed and uppercased, which
 * is how an unknown category stays visible in the log.
 */
export function canonicalXeroWebhookEventCategory(
  eventCategory: string | null | undefined,
): string | null {
  if (!eventCategory) {
    return null;
  }

  const normalized = eventCategory.trim().toUpperCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "CREDITNOTE" || normalized === "CREDIT_NOTE") {
    return "CREDITNOTE";
  }

  return normalized;
}

/**
 * Every stored spelling of one category. A filter or a link lookup for a
 * credit note has to find both `CREDITNOTE` (what Xero sends) and
 * `CREDIT_NOTE` (what this app used to expect).
 */
export function xeroWebhookEventCategorySpellings(eventCategory: string): string[] {
  if (canonicalXeroWebhookEventCategory(eventCategory) === "CREDITNOTE") {
    return [...CREDIT_NOTE_EVENT_CATEGORIES];
  }

  return [eventCategory];
}

/** Prisma `where` fragment for an inbound-event category filter. */
export function inboundEventCategoryFilter(
  eventCategory: string,
): { eventCategory: string } | { eventCategory: { in: string[] } } {
  const spellings = xeroWebhookEventCategorySpellings(eventCategory);
  if (spellings.length === 1) {
    return { eventCategory: spellings[0]! };
  }

  return { eventCategory: { in: spellings } };
}

/**
 * Webhook categories that can refer to one stored Xero object. A subscription
 * invoice arrives as `INVOICE`. A credit note arrives as `CREDITNOTE` and may
 * also be stored as `CREDIT_NOTE`.
 */
export function inboundEventCategoriesForXeroObjectType(xeroObjectType: string): string[] {
  switch (xeroObjectType) {
    case "SUBSCRIPTION":
      return ["INVOICE"];
    case "CONTACT":
    case "INVOICE":
    case "PAYMENT":
      return [xeroObjectType];
    case "CREDIT_NOTE":
    case "CREDITNOTE":
      return [...CREDIT_NOTE_EVENT_CATEGORIES];
    default:
      return [];
  }
}

/** Dropdown value for a category query, so an old `CREDIT_NOTE` bookmark selects Credit Notes. */
export function xeroInboundCategoryFilterValue(value: string | null | undefined): string {
  if (!value || value === "all") {
    return "all";
  }

  if (canonicalXeroWebhookEventCategory(value) === "CREDITNOTE") {
    return "CREDITNOTE";
  }

  return value;
}
