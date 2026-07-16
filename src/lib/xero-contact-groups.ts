/**
 * Xero contact group cache refresh and per-contact group membership sync.
 *
 * Owns the bulk contact-group refresh (`refreshXeroContactGroupCache`),
 * read helpers backed by the local cache, and the managed contact-group
 * sync that runs after a member's age tier changes.
 */

import { ContactGroup, type Contact, type Contacts } from "xero-node";
import logger from "@/lib/logger";
import { prisma } from "./prisma";
import {
  loadXeroGroupingContext,
  planMemberGroupingSync,
  resolveMemberGroupingForMember,
} from "@/lib/xero-member-grouping";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "./xero-api-client";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import { isXeroConnected } from "@/lib/xero-token-store";
import { buildXeroContactUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  buildXeroPayloadHash,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import {
  CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
  CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE,
  extractActiveXeroContactGroups,
  fetchXeroContactsByIdsFromXero,
  refreshXeroContactCachesFromContact,
  upsertXeroContactCacheEntry,
} from "./xero-contact-cache";
import {
  DEFAULT_XERO_SYNC_SCOPE,
  getXeroSyncCursor,
  toPrismaJson,
} from "./xero-sync-cursors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RefreshXeroContactGroupCacheOptions {
  repairMissingContactCache?: boolean;
}

interface RefreshedXeroContactGroup {
  id: string;
  name: string;
  contactCount: number;
  contacts: Array<{ id: string; name: string | null }>;
}

export interface SyncManagedMemberXeroContactGroupResult {
  memberId: string;
  xeroContactId: string | null;
  expectedGroupId: string | null;
  expectedGroupName: string | null;
  addedGroupIds: string[];
  removedGroupIds: string[];
  /**
   * Planned removes that 404'd — the contact was already out of the group
   * (idempotent success), so they are NOT counted as removals.
   */
  alreadyAbsentGroupIds: string[];
  skippedReason: string | null;
}

// ---------------------------------------------------------------------------
// Bulk contact group cache refresh
// ---------------------------------------------------------------------------

async function fetchXeroContactGroupsFromXero(): Promise<
  RefreshedXeroContactGroup[]
> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getContactGroups(tenantId),
    {
      operation: "getContactGroups",
      resourceType: "CONTACT_GROUP",
      workflow: "refreshXeroContactGroupCache",
      context: "refreshXeroContactGroupCache getContactGroups",
    }
  );
  const groups = (response.body.contactGroups ?? []).filter(
    (group) =>
      group.contactGroupID &&
      group.name &&
      group.status === ContactGroup.StatusEnum.ACTIVE
  );

  const refreshedGroups: RefreshedXeroContactGroup[] = [];
  for (const group of groups) {
    const detail = await callXeroApi(
      () =>
        xero.accountingApi.getContactGroup(tenantId, group.contactGroupID!),
      {
        operation: "getContactGroup",
        resourceType: "CONTACT_GROUP",
        workflow: "refreshXeroContactGroupCache",
        context: `refreshXeroContactGroupCache getContactGroup(${group.name})`,
      }
    );

    const contacts = (detail.body.contactGroups?.[0]?.contacts ?? [])
      .filter((contact) => contact.contactID)
      .map((contact) => ({
        id: contact.contactID!,
        name:
          contact.name ??
          [contact.firstName, contact.lastName].filter(Boolean).join(" ") ??
          null,
      }));

    refreshedGroups.push({
      id: group.contactGroupID!,
      name: group.name!,
      contactCount: contacts.length,
      contacts,
    });
  }

  refreshedGroups.sort((left, right) => left.name.localeCompare(right.name));
  return refreshedGroups;
}

async function repairMissingXeroContactCacheEntriesForGroups(
  refreshedGroups: RefreshedXeroContactGroup[],
  fetchedAt: Date
): Promise<void> {
  const contactIds = Array.from(
    new Set(
      refreshedGroups.flatMap((group) =>
        group.contacts.map((contact) => contact.id)
      )
    )
  );
  if (contactIds.length === 0) {
    return;
  }

  const cachedRows = await prisma.xeroContactCache.findMany({
    where: {
      contactId: {
        in: contactIds,
      },
    },
    select: {
      contactId: true,
    },
  });
  const cachedContactIds = new Set(cachedRows.map((row) => row.contactId));
  const missingContactIds = contactIds.filter(
    (contactId) => !cachedContactIds.has(contactId)
  );
  if (missingContactIds.length === 0) {
    return;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const repairedContacts = await fetchXeroContactsByIdsFromXero({
    xero,
    tenantId,
    contactIds: missingContactIds,
    workflow: "refreshXeroContactGroupCache",
    contextPrefix: "refreshXeroContactGroupCache repair missing contact cache",
    includeArchived: true,
  });

  const repairedContactIds = new Set<string>();
  for (const contact of repairedContacts) {
    const cachedContact = await upsertXeroContactCacheEntry(contact, fetchedAt);
    if (cachedContact) {
      repairedContactIds.add(cachedContact.contactId);
    }
  }

  const unrepairedContactIds = missingContactIds.filter(
    (contactId) => !repairedContactIds.has(contactId)
  );
  if (unrepairedContactIds.length > 0) {
    logger.warn(
      {
        missingContactCount: unrepairedContactIds.length,
        missingContactIds: unrepairedContactIds,
      },
      "Xero contact group refresh could not repair every missing contact cache entry"
    );
  }
}

// test seam
export async function refreshXeroContactGroupCache(
  options: RefreshXeroContactGroupCacheOptions = {}
): Promise<Array<{ id: string; name: string; contactCount: number }>> {
  const refreshStartedAt = new Date();
  const refreshedGroups = await fetchXeroContactGroupsFromXero();
  const refreshedAt = new Date();
  const membershipCount = refreshedGroups.reduce(
    (total, group) => total + group.contacts.length,
    0
  );

  if (options.repairMissingContactCache) {
    await repairMissingXeroContactCacheEntriesForGroups(
      refreshedGroups,
      refreshedAt
    );
  }

  await prisma.$transaction(async (tx) => {
    const refreshedGroupIds = refreshedGroups.map((group) => group.id);

    if (refreshedGroupIds.length > 0) {
      await tx.xeroContactGroupMembershipCache.deleteMany({
        where: { contactGroupId: { notIn: refreshedGroupIds } },
      });
      await tx.xeroContactGroupCache.deleteMany({
        where: { contactGroupId: { notIn: refreshedGroupIds } },
      });
    } else {
      await tx.xeroContactGroupMembershipCache.deleteMany({});
      await tx.xeroContactGroupCache.deleteMany({});
    }

    for (const group of refreshedGroups) {
      await tx.xeroContactGroupCache.upsert({
        where: { contactGroupId: group.id },
        create: {
          contactGroupId: group.id,
          name: group.name,
          status: "ACTIVE",
          contactCount: group.contactCount,
          fetchedAt: refreshedAt,
        },
        update: {
          name: group.name,
          status: "ACTIVE",
          contactCount: group.contactCount,
          fetchedAt: refreshedAt,
        },
      });

      await tx.xeroContactGroupMembershipCache.deleteMany({
        where: { contactGroupId: group.id },
      });

      if (group.contacts.length > 0) {
        await tx.xeroContactGroupMembershipCache.createMany({
          data: group.contacts.map((contact) => ({
            contactGroupId: group.id,
            contactId: contact.id,
            contactName: contact.name,
            fetchedAt: refreshedAt,
          })),
          skipDuplicates: true,
        });
      }
    }

    await tx.xeroSyncCursor.upsert({
      where: {
        resourceType_scope: {
          resourceType: CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
          scope: DEFAULT_XERO_SYNC_SCOPE,
        },
      },
      create: {
        resourceType: CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
        scope: DEFAULT_XERO_SYNC_SCOPE,
        cursorDateTime: refreshStartedAt,
        lastSuccessfulSyncAt: refreshedAt,
        metadata: toPrismaJson({
          groupCount: refreshedGroups.length,
          membershipCount,
        }),
      },
      update: {
        cursorDateTime: refreshStartedAt,
        lastSuccessfulSyncAt: refreshedAt,
        metadata: toPrismaJson({
          groupCount: refreshedGroups.length,
          membershipCount,
        }),
      },
    });

    // Dedicated cursor for the full "Refresh Xero Groups" rebuild only. Unlike
    // CONTACT_GROUP_CACHE_CURSOR_RESOURCE (also bumped by per-contact
    // reconciliation), this is written solely here, so the admin members page
    // can report how stale the whole cached snapshot is.
    await tx.xeroSyncCursor.upsert({
      where: {
        resourceType_scope: {
          resourceType: CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE,
          scope: DEFAULT_XERO_SYNC_SCOPE,
        },
      },
      create: {
        resourceType: CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE,
        scope: DEFAULT_XERO_SYNC_SCOPE,
        lastSuccessfulSyncAt: refreshedAt,
        metadata: toPrismaJson({
          groupCount: refreshedGroups.length,
          membershipCount,
        }),
      },
      update: {
        lastSuccessfulSyncAt: refreshedAt,
        metadata: toPrismaJson({
          groupCount: refreshedGroups.length,
          membershipCount,
        }),
      },
    });
  });

  return refreshedGroups.map((group) => ({
    id: group.id,
    name: group.name,
    contactCount: group.contactCount,
  }));
}

// ---------------------------------------------------------------------------
// Read helpers (backed by the local cache)
// ---------------------------------------------------------------------------

export async function getXeroContactGroups(options?: {
  refreshFromXero?: boolean;
  repairMissingContactCache?: boolean;
}): Promise<Array<{ id: string; name: string; contactCount: number }>> {
  if (options?.refreshFromXero) {
    return refreshXeroContactGroupCache({
      repairMissingContactCache: options.repairMissingContactCache,
    });
  }

  const groups = await prisma.xeroContactGroupCache.findMany({
    where: { status: "ACTIVE" },
    orderBy: [{ name: "asc" }],
    select: {
      contactGroupId: true,
      name: true,
      contactCount: true,
    },
  });

  return groups.map((group) => ({
    id: group.contactGroupId,
    name: group.name,
    contactCount: group.contactCount,
  }));
}

/**
 * Returns the ISO timestamp of the last full contact-group cache rebuild (the
 * "Refresh Xero Groups" admin action), or null when a full refresh has never
 * run. Reads the dedicated {@link CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE}
 * cursor — NOT the shared `CONTACT_GROUP_CACHE` cursor, whose timestamp is also
 * bumped by per-contact reconciliation (member link/import, inbound webhooks)
 * and would therefore under-report how stale the cached snapshot is.
 */
export async function getXeroContactGroupCacheLastRefreshedAt(): Promise<
  string | null
> {
  const cursor = await getXeroSyncCursor(
    CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE,
    DEFAULT_XERO_SYNC_SCOPE
  );
  return cursor?.lastSuccessfulSyncAt
    ? cursor.lastSuccessfulSyncAt.toISOString()
    : null;
}

export async function getXeroContactGroupMemberships(
  contactIds: string[]
): Promise<Record<string, Array<{ id: string; name: string }>>> {
  const uniqueContactIds = Array.from(new Set(contactIds));
  if (uniqueContactIds.length === 0) {
    return {};
  }

  const cursor = await getXeroSyncCursor(
    CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
    DEFAULT_XERO_SYNC_SCOPE
  );
  if (!cursor?.lastSuccessfulSyncAt) {
    return {};
  }

  const memberships: Record<string, Array<{ id: string; name: string }>> =
    Object.fromEntries(uniqueContactIds.map((contactId) => [contactId, []]));

  const rows = await prisma.xeroContactGroupMembershipCache.findMany({
    where: {
      contactId: { in: uniqueContactIds },
      group: { is: { status: "ACTIVE" } },
    },
    select: {
      contactId: true,
      group: {
        select: {
          contactGroupId: true,
          name: true,
        },
      },
    },
  });

  for (const row of rows) {
    memberships[row.contactId].push({
      id: row.group.contactGroupId,
      name: row.group.name,
    });
  }

  for (const groups of Object.values(memberships)) {
    groups.sort((left, right) => left.name.localeCompare(right.name));
  }

  return memberships;
}

/** Get all Xero contact IDs that belong to a specific contact group. */
export async function getXeroContactIdsForGroup(
  groupId: string
): Promise<string[]> {
  const cursor = await getXeroSyncCursor(
    CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
    DEFAULT_XERO_SYNC_SCOPE
  );
  if (!cursor?.lastSuccessfulSyncAt) {
    return [];
  }

  const memberships = await prisma.xeroContactGroupMembershipCache.findMany({
    where: { contactGroupId: groupId },
    select: { contactId: true },
  });

  return memberships.map((membership) => membership.contactId);
}

// ---------------------------------------------------------------------------
// Managed contact-group sync for a single member
// ---------------------------------------------------------------------------

export async function syncManagedXeroContactGroupForMember(
  memberId: string,
  options?: {
    createdByMemberId?: string;
  }
): Promise<SyncManagedMemberXeroContactGroupResult> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      ageTier: true,
      firstName: true,
      lastName: true,
      xeroContactId: true,
    },
  });
  if (!member) {
    throw new Error(`Member not found: ${memberId}`);
  }

  if (!member.xeroContactId) {
    return {
      memberId,
      xeroContactId: null,
      expectedGroupId: null,
      expectedGroupName: null,
      addedGroupIds: [],
      removedGroupIds: [],
      alreadyAbsentGroupIds: [],
      skippedReason: "member_has_no_xero_contact",
    };
  }

  // Mode-driven resolution (E8, #1934). NONE short-circuits BEFORE any Xero
  // call — the sync is a total no-op, existing Xero memberships untouched.
  const context = await loadXeroGroupingContext();
  const resolution = await resolveMemberGroupingForMember({
    memberId,
    ageTier: member.ageTier,
    context,
  });

  if (resolution.skippedReason === "grouping_mode_none") {
    return {
      memberId,
      xeroContactId: member.xeroContactId,
      expectedGroupId: null,
      expectedGroupName: null,
      addedGroupIds: [],
      removedGroupIds: [],
      alreadyAbsentGroupIds: [],
      skippedReason: "grouping_mode_none",
    };
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  const getContactFromXero = async (): Promise<Contact> => {
    const response = await callXeroApi(
      () => xero.accountingApi.getContact(tenantId, member.xeroContactId!),
      {
        operation: "getContact",
        resourceType: "CONTACT",
        workflow: "syncManagedXeroContactGroupForMember",
        context: `syncManagedXeroContactGroupForMember getContact(${member.xeroContactId})`,
      }
    );
    const contact = response.body.contacts?.[0];
    if (!contact?.contactID) {
      throw new Error(`Xero contact ${member.xeroContactId} was not found`);
    }
    return contact;
  };

  const initialContact = await getContactFromXero();
  const currentGroups = extractActiveXeroContactGroups(initialContact) ?? [];
  const plan = planMemberGroupingSync({
    resolution,
    currentGroupIds: currentGroups.map((group) => group.id),
  });

  const managedGroup = resolution.managedGroup;

  // No matching rule for this member's type/tier: leave the contact untouched
  // (stale memberships surface in the mismatch snapshot for admin cleanup) but
  // keep the cache fresh from the read we just did.
  if (resolution.skippedReason === "no_matching_rule") {
    await refreshXeroContactCachesFromContact(initialContact);
    return {
      memberId,
      xeroContactId: member.xeroContactId,
      expectedGroupId: null,
      expectedGroupName: null,
      addedGroupIds: [],
      removedGroupIds: [],
      alreadyAbsentGroupIds: [],
      skippedReason: "no_matching_rule",
    };
  }

  if (plan.isNoop) {
    await refreshXeroContactCachesFromContact(initialContact);
    return {
      memberId,
      xeroContactId: member.xeroContactId,
      expectedGroupId: managedGroup?.id ?? null,
      expectedGroupName: managedGroup?.name ?? null,
      addedGroupIds: [],
      removedGroupIds: [],
      alreadyAbsentGroupIds: [],
      skippedReason: null,
    };
  }

  const requestPayload = {
    memberId,
    memberName: `${member.firstName} ${member.lastName}`,
    mode: resolution.mode,
    ageTier: member.ageTier,
    xeroContactId: member.xeroContactId,
    managedGroup,
    acceptedGroupIds: resolution.acceptedGroupIds,
    managedUniverse: resolution.managedUniverse,
    plannedAddGroupId: plan.groupToAdd?.id ?? null,
    plannedRemoveGroupIds: plan.groupIdsToRemove,
    currentGroups: currentGroups.map((group) => ({
      id: group.id,
      name: group.name,
    })),
  };
  const payloadHash = buildXeroPayloadHash(requestPayload);
  const idempotencyKey = buildXeroIdempotencyKey(
    "member",
    memberId,
    "managed-contact-group",
    payloadHash,
    "v2"
  );
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CONTACT_GROUP",
    operationType: "SYNC_MANAGED_MEMBERSHIP",
    localModel: "Member",
    localId: memberId,
    idempotencyKey,
    correlationKey: idempotencyKey,
    requestPayload,
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  const addedGroupIds: string[] = [];
  const removedGroupIds: string[] = [];
  const alreadyAbsentGroupIds: string[] = [];
  try {
    // Add before remove (unchanged ordering). An add failure (incl. HTTP 404 —
    // e.g. the target group was deleted in Xero) is a ledgered failure that
    // propagates to the catch below.
    if (plan.groupToAdd) {
      const groupToAdd = plan.groupToAdd;
      const contacts: Contacts = {
        contacts: [{ contactID: member.xeroContactId }],
      };
      // Include the operation id as a per-operation nonce: retries inside
      // this operation share the key, but a legitimate later re-add (e.g.
      // tier flips back within Xero's 24h idempotency window) gets a fresh
      // key instead of being silently swallowed by Xero.
      const addIdempotencyKey = buildXeroIdempotencyKey(
        "contact",
        member.xeroContactId,
        "contact-group-add",
        `${groupToAdd.id}:${operation.id}`,
        "v2"
      );
      await callXeroApi(
        () =>
          xero.accountingApi.createContactGroupContacts(
            tenantId,
            groupToAdd.id,
            contacts,
            addIdempotencyKey
          ),
        {
          operation: "createContactGroupContacts",
          resourceType: "CONTACT_GROUP",
          workflow: "syncManagedXeroContactGroupForMember",
          context: `createContactGroupContacts(${groupToAdd.id}, ${member.xeroContactId})`,
        }
      );
      addedGroupIds.push(groupToAdd.id);
    }

    for (const groupId of plan.groupIdsToRemove) {
      try {
        await callXeroApi(
          () =>
            xero.accountingApi.deleteContactGroupContact(
              tenantId,
              groupId,
              member.xeroContactId!
            ),
          {
            operation: "deleteContactGroupContact",
            resourceType: "CONTACT_GROUP",
            workflow: "syncManagedXeroContactGroupForMember",
            context: `deleteContactGroupContact(${groupId}, ${member.xeroContactId})`,
          }
        );
        removedGroupIds.push(groupId);
      } catch (removeError) {
        // A remove-404 means the contact is already out of the group — treat as
        // idempotent success rather than failing the whole operation, but
        // record it separately so it is never counted as a removal.
        if (getXeroErrorStatusCode(removeError) === 404) {
          logger.info(
            { memberId, xeroContactId: member.xeroContactId, groupId },
            "Xero contact already absent from managed group (404 on remove) — treated as success"
          );
          alreadyAbsentGroupIds.push(groupId);
          continue;
        }
        throw removeError;
      }
    }

    const refreshedContact = await getContactFromXero();
    await refreshXeroContactCachesFromContact(refreshedContact);

    await completeXeroSyncOperation(operation.id, {
      responsePayload: {
        addedGroupIds,
        removedGroupIds,
        alreadyAbsentGroupIds,
        resultingGroups: (
          extractActiveXeroContactGroups(refreshedContact) ?? []
        ).map((group) => ({
          id: group.id,
          name: group.name,
        })),
      },
      xeroObjectType: "CONTACT",
      xeroObjectId: member.xeroContactId,
      xeroObjectUrl: buildXeroContactUrl(member.xeroContactId),
      extraLinks: [
        {
          localModel: "Member",
          localId: memberId,
          xeroObjectType: "CONTACT",
          xeroObjectId: member.xeroContactId,
          xeroObjectUrl: buildXeroContactUrl(member.xeroContactId),
          role: "CONTACT",
        },
      ],
    });

    return {
      memberId,
      xeroContactId: member.xeroContactId,
      expectedGroupId: managedGroup?.id ?? null,
      expectedGroupName: managedGroup?.name ?? null,
      addedGroupIds,
      removedGroupIds,
      alreadyAbsentGroupIds,
      skippedReason: null,
    };
  } catch (error) {
    try {
      const latestContact = await getContactFromXero();
      await refreshXeroContactCachesFromContact(latestContact);
    } catch (refreshError) {
      logger.warn(
        { err: refreshError, memberId, xeroContactId: member.xeroContactId },
        "Failed to refresh Xero contact caches after managed contact group sync error"
      );
    }

    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

/**
 * Shared best-effort trigger for member Xero contact-group re-sync (E8, #1934).
 *
 * Use this from any site that changes a member's grouping-relevant state (age
 * tier, effective membership type). It is guarded by `isXeroConnected`, never
 * throws (Xero failures are logged, not fatal), and is safe to call
 * unconditionally — `syncManagedXeroContactGroupForMember` short-circuits to a
 * no-op before any Xero call when the mode is NONE or the member has no Xero
 * contact, so callers do not need to check the mode. Idempotent on re-run.
 *
 * E10 (#1936) calls this from application-approval mapping.
 */
export async function triggerMemberXeroContactGroupSync(
  memberId: string,
  options?: { createdByMemberId?: string; reason?: string }
): Promise<void> {
  try {
    if (!(await isXeroConnected())) {
      return;
    }
    await syncManagedXeroContactGroupForMember(memberId, {
      createdByMemberId: options?.createdByMemberId,
    });
  } catch (error) {
    logger.error(
      { err: error, memberId, reason: options?.reason ?? null },
      "Best-effort Xero contact group sync failed"
    );
  }
}
