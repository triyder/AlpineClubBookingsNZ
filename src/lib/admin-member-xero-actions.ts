/**
 * Shared admin-member Xero action wrappers.
 *
 * Both the admin members list (`/admin/members`) and member detail
 * (`/admin/members/[id]`) pages call the same four Xero contact
 * endpoints — search, link, unlink, push (create) — with the same
 * request and response shapes. The pages keep their own state
 * machines and copy because the UX diverges, but the network calls
 * live here so the request/response contract stays in one place.
 *
 * Each function throws an `Error` with the server-provided message
 * when the response is not ok. Callers convert that into the local
 * error display (formError / xeroError / xeroDecisionError etc.).
 */
import type { XeroSearchResult } from "@/components/admin/xero-suggested-contact-card";

interface XeroEntranceFeeInvoicePushOptions {
  createEntranceFeeInvoice: boolean;
  entranceFeeInvoiceDecision?: "CREATE" | "SKIP";
  entranceFeeInvoiceSkipReason?: string;
  entranceFeeInvoiceAmountCents?: number;
  entranceFeeInvoiceNarration?: string;
}

export interface XeroPushOptions extends XeroEntranceFeeInvoicePushOptions {
  forceCreate?: boolean;
}

export interface XeroPushResponse {
  xeroContactId: string;
  xeroLink?: string;
  entranceFeeInvoiceQueued?: boolean;
  entranceFeeInvoiceMessage?: string;
  warning?: string;
  // Member detail returns additional fields the list page ignores; allow them through.
  [key: string]: unknown;
}

export type XeroPushResult =
  | { status: "created"; data: XeroPushResponse }
  | { status: "needsDecision"; suggestedContacts: XeroSearchResult[] };

export interface XeroLinkResponse {
  contactName?: string;
  [key: string]: unknown;
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error.length > 0) {
      return data.error;
    }
  } catch {
    // Response body not JSON; fall through.
  }
  return fallback;
}

/**
 * Search Xero contacts by free-text query. Returns the raw contact list
 * including contacts already linked to other members; callers filter as
 * needed.
 */
export async function searchXeroContacts(query: string): Promise<XeroSearchResult[]> {
  const res = await fetch(`/api/admin/xero/search-contacts?q=${encodeURIComponent(query)}`);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Failed to search Xero contacts"));
  }
  const data = (await res.json()) as { contacts?: XeroSearchResult[] };
  return data.contacts ?? [];
}

/**
 * Link a local member to an existing Xero contact.
 */
export async function linkMemberXeroContact(
  memberId: string,
  xeroContactId: string,
): Promise<XeroLinkResponse> {
  const res = await fetch(`/api/admin/members/${memberId}/xero-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xeroContactId }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Failed to link Xero contact"));
  }
  return (await res.json().catch(() => ({}))) as XeroLinkResponse;
}

/**
 * Unlink a local member from its Xero contact.
 */
export async function unlinkMemberXeroContact(memberId: string): Promise<void> {
  const res = await fetch(`/api/admin/members/${memberId}/xero-unlink`, { method: "POST" });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Failed to unlink Xero contact"));
  }
}

/**
 * Push a local member to Xero as a new contact.
 *
 * Returns `{ status: "needsDecision" }` when the server replies 409 with
 * suggested existing matches; the caller shows the decision UI and may
 * retry with `forceCreate: true` or call `linkMemberXeroContact` with a
 * chosen contact ID.
 */
export async function pushMemberToXero(
  memberId: string,
  options: XeroPushOptions,
): Promise<XeroPushResult> {
  const res = await fetch(`/api/admin/members/${memberId}/xero-push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      createEntranceFeeInvoice: Boolean(options.createEntranceFeeInvoice),
      entranceFeeInvoiceDecision: options.entranceFeeInvoiceDecision,
      entranceFeeInvoiceSkipReason: options.entranceFeeInvoiceSkipReason,
      entranceFeeInvoiceAmountCents: options.entranceFeeInvoiceAmountCents,
      entranceFeeInvoiceNarration: options.entranceFeeInvoiceNarration,
      forceCreate: Boolean(options.forceCreate),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as
    | (XeroPushResponse & { error?: string; suggestedContacts?: XeroSearchResult[] });

  if (res.status === 409 && Array.isArray(data.suggestedContacts)) {
    return { status: "needsDecision", suggestedContacts: data.suggestedContacts };
  }

  if (!res.ok) {
    const fallback = "Failed to create Xero contact";
    throw new Error(typeof data.error === "string" && data.error.length > 0 ? data.error : fallback);
  }

  return { status: "created", data };
}
