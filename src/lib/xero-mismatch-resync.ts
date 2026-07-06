import { prisma } from "@/lib/prisma";
import { getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { isXeroConnected } from "@/lib/xero-token-store";
import {
  fetchXeroContactsByIdsFromXero,
  refreshXeroContactCachesFromContact,
} from "@/lib/xero-contact-cache";

/**
 * Targeted cache resync for the admin Xero mismatch panels (#1441).
 *
 * The mismatch snapshots recompute purely from the local cache tables, so a
 * fix made inside Xero stays invisible until some bulk sync happens to
 * rewrite the caches. This helper re-fetches exactly the flagged contacts
 * from Xero (read-only toward Xero; batches of 50 metered via callXeroApi)
 * and rewrites their cache rows so the recompute sees current truth.
 *
 * It deliberately does NOT advance the CONTACT delta-sync watermark: bumping
 * it after a targeted fetch would make the next full delta sync skip every
 * other contact changed since the real watermark. Panels display the
 * returned `resyncedAt` instead. (One pre-existing side effect to know
 * about: refreshXeroContactGroupMembershipCacheForContact dual-writes the
 * shared CONTACT_GROUP_CACHE cursor timestamp per contact — see #1443; the
 * authoritative full-refresh staleness signal is the separate
 * CONTACT_GROUP_FULL_REFRESH cursor, which this never touches.)
 */

export class XeroResyncUnavailableError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "XeroResyncUnavailableError";
    this.status = status;
  }
}

export interface XeroContactResyncSummary {
  /** Distinct contact ids the caller asked to resync. */
  requestedContacts: number;
  /** Contacts Xero returned and whose cache rows were rewritten. */
  resyncedContacts: number;
  /**
   * Contacts Xero no longer returned even with archived included; their
   * stale cache rows were dropped so they stop feeding the audits.
   */
  removedContacts: number;
  resyncedAt: string;
}

export async function resyncXeroContactCachesByIds(
  contactIds: ReadonlyArray<string | null | undefined>,
  workflow: string
): Promise<XeroContactResyncSummary> {
  const uniqueContactIds = [
    ...new Set(
      contactIds.filter((contactId): contactId is string => Boolean(contactId))
    ),
  ];

  const resyncedAt = new Date();
  if (uniqueContactIds.length === 0) {
    return {
      requestedContacts: 0,
      resyncedContacts: 0,
      removedContacts: 0,
      resyncedAt: resyncedAt.toISOString(),
    };
  }

  if (!(await isXeroConnected())) {
    throw new XeroResyncUnavailableError(
      "Xero is not connected — connect it before re-syncing contacts.",
      409
    );
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contacts = await fetchXeroContactsByIdsFromXero({
    xero,
    tenantId,
    contactIds: uniqueContactIds,
    workflow,
    contextPrefix: workflow,
    // Contacts archived in Xero must still come back so their cache rows
    // update (Xero drops archived contacts from groups) instead of going
    // permanently stale.
    includeArchived: true,
  });

  // refreshXeroContactCachesFromContact upserts one contact per call (its
  // own short writes), so a failed batch leaves earlier contacts fully
  // written and later ones untouched — never half-written rows.
  for (const contact of contacts) {
    await refreshXeroContactCachesFromContact(contact, resyncedAt);
  }

  const returnedContactIds = new Set(
    contacts
      .map((contact) => contact.contactID)
      .filter((contactId): contactId is string => Boolean(contactId))
  );
  const missingContactIds = uniqueContactIds.filter(
    (contactId) => !returnedContactIds.has(contactId)
  );

  if (missingContactIds.length > 0) {
    // Xero no longer knows these ids (deleted/merged): drop the stale cache
    // rows so the audits stop reporting against phantom contacts. The
    // member's own xeroContactId link is left for the admin to fix via the
    // existing unlink/relink actions.
    await prisma.xeroContactCache.deleteMany({
      where: { contactId: { in: missingContactIds } },
    });
    await prisma.xeroContactGroupMembershipCache.deleteMany({
      where: { contactId: { in: missingContactIds } },
    });
  }

  return {
    requestedContacts: uniqueContactIds.length,
    resyncedContacts: contacts.length,
    removedContacts: missingContactIds.length,
    resyncedAt: resyncedAt.toISOString(),
  };
}
