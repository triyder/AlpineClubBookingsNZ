/**
 * Xero member grouping — mode-driven dry-run snapshot + bulk re-sync (E8, #1934).
 *
 * The snapshot generalises the old age-tier mismatch snapshot
 * (`getXeroContactGroupMismatchSnapshot`) to the mode model: it recomputes,
 * purely from the local caches, which members would have a group add/remove
 * under the current mode + active rules, plus a call-budget estimate. It NEVER
 * calls Xero.
 *
 * The bulk re-sync is admin-triggered only and, in this wave, ships as code +
 * runbook (never executed against live Xero). A run is mandatory-preceded by a
 * dry-run. It is:
 *  - cache-first pre-filtered: only members the snapshot flags are touched
 *    (reuse of the #1441 cache-recompute precedent);
 *  - chunked + resumable via a member-id cursor;
 *  - rate-limited by the existing withXeroRetry/callXeroApi 429 minute/day
 *    classification inside `syncManagedXeroContactGroupForMember`;
 *  - per-member failures are ledgered (inside the per-member sync) and
 *    non-fatal to the run; a daily-limit stop is surfaced so the run resumes;
 *  - members without a Xero contact are reported as skipped, never omitted.
 *
 * It NEVER advances the CONTACT delta-sync watermark; the per-member sync only
 * refreshes the contact/group caches (which dual-write the CONTACT_GROUP_CACHE
 * cursor per #1443). The CONTACT_GROUP_FULL_REFRESH cursor stays the
 * authoritative group-cache staleness signal.
 */

import type { AgeTier, XeroMemberGroupingMode } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { XeroDailyLimitError } from "@/lib/xero-api-client";
import { syncManagedXeroContactGroupForMember } from "@/lib/xero-contact-groups";
import {
  loadXeroGroupingContext,
  planMemberGroupingSync,
  resolveMemberGroupingsForMembers,
  type XeroGroupRef,
} from "@/lib/xero-member-grouping";

const CONTACT_GROUP_CACHE_CURSOR_RESOURCE = "CONTACT_GROUP_CACHE";
const DEFAULT_XERO_SYNC_SCOPE = "default";

export interface MemberGroupingDiffEntry {
  memberId: string;
  memberName: string;
  memberEmail: string;
  ageTier: AgeTier;
  xeroContactId: string;
  managedGroup: XeroGroupRef | null;
  addGroupId: string | null;
  removeGroupIds: string[];
}

export interface MemberGroupingSnapshot {
  mode: XeroMemberGroupingMode;
  cacheReady: boolean;
  lastRefreshedAt: string | null;
  activeRuleCount: number;
  membersConsidered: number;
  mismatchCount: number;
  addCount: number;
  removeCount: number;
  /** Rough upper bound of Xero calls a full re-sync of the mismatches costs. */
  estimatedXeroCalls: number;
  skippedNoContact: Array<{ memberId: string; memberName: string }>;
  mismatches: MemberGroupingDiffEntry[];
}

function memberName(member: { firstName: string; lastName: string; email: string }): string {
  return `${member.firstName} ${member.lastName}`.trim() || member.email;
}

/**
 * Pure per-member Xero-call estimate for a planned change: getContact +
 * (add?1:0) + removes + a post-write getContact refresh.
 */
function estimateCallsFor(entry: MemberGroupingDiffEntry): number {
  return 1 + (entry.addGroupId ? 1 : 0) + entry.removeGroupIds.length + 1;
}

/**
 * Mode-driven dry-run snapshot. Recomputes from the local caches only.
 */
export async function getXeroMemberGroupingSnapshot(options?: {
  limit?: number;
}): Promise<MemberGroupingSnapshot> {
  const [context, cursor] = await Promise.all([
    loadXeroGroupingContext(),
    prisma.xeroSyncCursor.findUnique({
      where: {
        resourceType_scope: {
          resourceType: CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
          scope: DEFAULT_XERO_SYNC_SCOPE,
        },
      },
      select: { lastSuccessfulSyncAt: true },
    }),
  ]);

  const base = {
    mode: context.mode,
    activeRuleCount: context.activeRules.length,
  };

  if (!cursor?.lastSuccessfulSyncAt) {
    return {
      ...base,
      cacheReady: false,
      lastRefreshedAt: null,
      membersConsidered: 0,
      mismatchCount: 0,
      addCount: 0,
      removeCount: 0,
      estimatedXeroCalls: 0,
      skippedNoContact: [],
      mismatches: [],
    };
  }

  const lastRefreshedAt = cursor.lastSuccessfulSyncAt.toISOString();

  // NONE mode: the sync is a total no-op, so there is never a diff.
  if (context.mode === "NONE") {
    return {
      ...base,
      cacheReady: true,
      lastRefreshedAt,
      membersConsidered: 0,
      mismatchCount: 0,
      addCount: 0,
      removeCount: 0,
      estimatedXeroCalls: 0,
      skippedNoContact: [],
      mismatches: [],
    };
  }

  const members = await prisma.member.findMany({
    where: { active: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      ageTier: true,
      xeroContactId: true,
    },
  });

  const withContact = members.filter(
    (member): member is typeof member & { xeroContactId: string } =>
      Boolean(member.xeroContactId),
  );
  const skippedNoContact = members
    .filter((member) => !member.xeroContactId)
    .map((member) => ({ memberId: member.id, memberName: memberName(member) }));

  const contactIds = withContact.map((member) => member.xeroContactId);
  const memberships = contactIds.length
    ? await prisma.xeroContactGroupMembershipCache.findMany({
        where: { contactId: { in: contactIds }, group: { is: { status: "ACTIVE" } } },
        select: { contactId: true, contactGroupId: true },
      })
    : [];
  const groupIdsByContactId = new Map<string, string[]>();
  for (const row of memberships) {
    const list = groupIdsByContactId.get(row.contactId) ?? [];
    list.push(row.contactGroupId);
    groupIdsByContactId.set(row.contactId, list);
  }

  const resolutions = await resolveMemberGroupingsForMembers({
    members: withContact.map((member) => ({ id: member.id, ageTier: member.ageTier })),
    context,
  });

  const mismatches: MemberGroupingDiffEntry[] = [];
  let addCount = 0;
  let removeCount = 0;
  let estimatedXeroCalls = 0;

  for (const member of withContact) {
    const resolution = resolutions.get(member.id);
    if (!resolution) continue;
    const plan = planMemberGroupingSync({
      resolution,
      currentGroupIds: groupIdsByContactId.get(member.xeroContactId) ?? [],
    });
    if (plan.isNoop) continue;

    const entry: MemberGroupingDiffEntry = {
      memberId: member.id,
      memberName: memberName(member),
      memberEmail: member.email,
      ageTier: member.ageTier,
      xeroContactId: member.xeroContactId,
      managedGroup: plan.managedGroup,
      addGroupId: plan.groupToAdd?.id ?? null,
      removeGroupIds: plan.groupIdsToRemove,
    };
    mismatches.push(entry);
    if (entry.addGroupId) addCount += 1;
    removeCount += entry.removeGroupIds.length;
    estimatedXeroCalls += estimateCallsFor(entry);
  }

  return {
    ...base,
    cacheReady: true,
    lastRefreshedAt,
    membersConsidered: withContact.length,
    mismatchCount: mismatches.length,
    addCount,
    removeCount,
    estimatedXeroCalls,
    skippedNoContact,
    mismatches:
      typeof options?.limit === "number"
        ? mismatches.slice(0, Math.max(1, options.limit))
        : mismatches,
  };
}

// ---------------------------------------------------------------------------
// Bulk re-sync
// ---------------------------------------------------------------------------

export interface BulkResyncRunOptions {
  /** Chunk size — how many mismatched members to process this call. */
  limit?: number;
  /** Resume: process members whose id sorts strictly after this cursor. */
  afterMemberId?: string;
  createdByMemberId?: string;
}

export interface BulkResyncRunResult {
  mode: XeroMemberGroupingMode;
  processed: number;
  added: number;
  removed: number;
  noop: number;
  failed: number;
  failures: Array<{ memberId: string; error: string }>;
  /** Cursor to pass as afterMemberId to continue; null when the run is done. */
  nextCursorMemberId: string | null;
  done: boolean;
  /** Set when a Xero daily limit halted the run mid-way (resume tomorrow). */
  haltedByDailyLimit: boolean;
}

const DEFAULT_BULK_CHUNK = 100;

/**
 * Execute one chunk of a bulk re-sync. Cache-first pre-filtered to the members
 * the dry-run snapshot flags, ordered by member id so the cursor is stable.
 * Per-member failures are recorded and non-fatal; a Xero daily-limit halts the
 * chunk early (resume by re-calling with the returned cursor). Callers MUST
 * present the dry-run diff before invoking this.
 */
export async function runXeroMemberGroupingBulkResyncChunk(
  options: BulkResyncRunOptions = {},
): Promise<BulkResyncRunResult> {
  const context = await loadXeroGroupingContext();
  const chunkSize = Math.max(1, options.limit ?? DEFAULT_BULK_CHUNK);

  const result: BulkResyncRunResult = {
    mode: context.mode,
    processed: 0,
    added: 0,
    removed: 0,
    noop: 0,
    failed: 0,
    failures: [],
    nextCursorMemberId: null,
    done: true,
    haltedByDailyLimit: false,
  };

  // NONE mode never touches Xero — nothing to re-sync.
  if (context.mode === "NONE") {
    return result;
  }

  // Cache-first pre-filter: recompute the full mismatch set, then window it by
  // the resume cursor + chunk size. This keeps the run touching ONLY mismatched
  // members, never the whole population.
  const snapshot = await getXeroMemberGroupingSnapshot();
  const ordered = snapshot.mismatches
    .slice()
    .sort((left, right) => left.memberId.localeCompare(right.memberId));
  const pending = options.afterMemberId
    ? ordered.filter((entry) => entry.memberId.localeCompare(options.afterMemberId!) > 0)
    : ordered;
  const chunk = pending.slice(0, chunkSize);

  for (const entry of chunk) {
    try {
      const syncResult = await syncManagedXeroContactGroupForMember(entry.memberId, {
        createdByMemberId: options.createdByMemberId,
      });
      result.processed += 1;
      result.added += syncResult.addedGroupIds.length;
      result.removed += syncResult.removedGroupIds.length;
      if (
        syncResult.addedGroupIds.length === 0 &&
        syncResult.removedGroupIds.length === 0
      ) {
        result.noop += 1;
      }
      result.nextCursorMemberId = entry.memberId;
    } catch (error) {
      if (error instanceof XeroDailyLimitError) {
        // Halt this chunk cleanly; the cursor stays at the last completed member
        // so a later resume picks up here.
        result.haltedByDailyLimit = true;
        result.done = false;
        logger.warn(
          { memberId: entry.memberId },
          "Xero member grouping bulk re-sync halted by daily API limit",
        );
        return result;
      }
      // Per-member failure is ledgered inside the sync; record + continue.
      result.failed += 1;
      result.failures.push({
        memberId: entry.memberId,
        error: error instanceof Error ? error.message : String(error),
      });
      result.nextCursorMemberId = entry.memberId;
      logger.error(
        { err: error, memberId: entry.memberId },
        "Xero member grouping bulk re-sync: member failed (continuing)",
      );
    }
  }

  result.done = pending.length <= chunk.length;
  if (result.done) {
    result.nextCursorMemberId = null;
  }
  return result;
}
