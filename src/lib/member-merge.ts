import { createHmac, timingSafeEqual } from "crypto";
import { AccessRole, type Member, type Prisma } from "@prisma/client";
import {
  actorIsFullAdmin,
  wouldRemoveLastFullAdmin,
} from "@/lib/admin-account-guards";
import { hasAdminAccess } from "@/lib/access-roles";
import { buildStructuredAuditLogCreateArgs } from "@/lib/audit";
import { memberDisplayName } from "@/lib/member-serialization";
import { prisma } from "@/lib/prisma";

/**
 * E11 (#1937) — additive, master-wins member profile merge.
 *
 * The whole operation runs in ONE interactive transaction guarded by a dual
 * `member-lifecycle:{id}` advisory lock (see docs/CONCURRENCY_AND_LOCKING.md).
 * It re-points every Member-referencing relation onto the master, additively
 * fills the master's blank scalar fields from the loser, tidies the loser's
 * Xero links, writes one critical audit, and hard-deletes the loser. There are
 * NO Xero API calls anywhere in this module — the loser's Xero contact is left
 * for manual clean-up (surfaced as a preview warning).
 */

export type MergeDbClient = Prisma.TransactionClient | typeof prisma;

export class MemberMergeError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "MemberMergeError";
  }
}

// ---------------------------------------------------------------------------
// Relation classification (the declarative FK universe)
// ---------------------------------------------------------------------------

/**
 * Every Member-referencing relation falls into exactly one bucket:
 *
 * - `move`    updateMany re-point loser -> master (history follows the person).
 *             No unique constraint on the member column, so no collision.
 * - `resolve` a unique constraint means naive re-pointing could collide; a
 *             per-model resolver dedupes (keep master / drop loser / special)
 *             then moves the survivors.
 * - `cascade` the row IS the loser's auth identity / an ephemeral token. It is
 *             never moved; `member.delete(loser)` cascade-drops it. Login,
 *             2FA and Xero identity are always the master's, never merged.
 *
 * FK-less scalar member-id columns (MemberLifecycleActionRequest.memberId,
 * MemberApplication nominator/reviewedBy, NominationToken.nominatorMemberId,
 * IssueReport.resolvedById/screenshotDeletedById, FamilyGroupJoinRequest/
 * DeletionRequest.reviewedBy, ...) are the fourth conceptual bucket, `snapshot`:
 * they carry no FK, so they are neither moved nor cascaded — they keep the
 * loser's id by design as immutable history (mirrors the delete path, which
 * also leaves these dangling). They are NOT relations, so they never appear in
 * the DMMF/schema relation walk and are documented, not classified, below.
 */
export type MemberMergeBucket = "move" | "resolve" | "cascade";

export type MemberMergeRelationSpec = {
  /** `Model.field` — the FK-owning relation field. */
  readonly key: string;
  readonly model: string;
  readonly field: string;
  /** Prisma delegate name (camelCase model). */
  readonly delegate: string;
  /** The scalar FK column that holds the Member id. */
  readonly column: string;
  readonly bucket: MemberMergeBucket;
  /**
   * For `move` relations only: when true this is a Member self-relation column,
   * so the master's own column is null-checked for a self-cycle before the
   * loser's inbound references are re-pointed.
   */
  readonly selfRelation?: boolean;
  readonly note?: string;
};

function spec(
  model: string,
  field: string,
  column: string,
  bucket: MemberMergeBucket,
  extra: { selfRelation?: boolean; note?: string } = {},
): MemberMergeRelationSpec {
  const delegate = model.charAt(0).toLowerCase() + model.slice(1);
  return { key: `${model}.${field}`, model, field, delegate, column, bucket, ...extra };
}

/**
 * The authoritative classification of all 70 Member FK-owning relations. The
 * DMMF/schema completeness test (member-merge-dmmf.test.ts) fails CI if the
 * schema grows a Member relation that is missing here (or if a key here no
 * longer exists in the schema), so a new relation cannot silently escape merge
 * handling.
 */
export const MEMBER_MERGE_RELATION_SPECS: readonly MemberMergeRelationSpec[] = [
  // --- Member self-relations (move inbound refs; null self-cycles first) ---
  spec("Member", "parent", "parentMemberId", "move", { selfRelation: true }),
  spec("Member", "secondaryParent", "secondaryParentId", "move", { selfRelation: true }),
  spec("Member", "inheritEmailFrom", "inheritEmailFromId", "move", { selfRelation: true }),
  spec("Member", "detailsConfirmedBy", "detailsConfirmedByMemberId", "move", { selfRelation: true }),

  // --- Access roles ---
  spec("MemberAccessRole", "member", "memberId", "resolve", {
    note: "@@unique(memberId,role)+@@unique(memberId,roleDefinitionId); admin-role loser blocked by guard; gained roles warned in preview",
  }),
  spec("MemberAccessRole", "assignedBy", "assignedByMemberId", "move"),

  // --- Auth identity / ephemeral tokens (cascade with loser) ---
  spec("PasswordResetToken", "member", "memberId", "cascade"),
  spec("EmailVerificationToken", "member", "memberId", "cascade"),
  spec("EmailChangeToken", "member", "memberId", "cascade"),
  spec("TwoFactorEmailCode", "member", "memberId", "cascade"),
  spec("TwoFactorRecoveryCode", "member", "memberId", "cascade"),
  spec("TwoFactorSessionChallenge", "member", "memberId", "cascade"),
  spec("PartnerInviteToken", "createdBy", "createdById", "cascade", {
    note: "single-use invite token created by loser; low-value ephemeral, dies with loser",
  }),

  // --- Subscriptions / billing ---
  spec("MemberSubscription", "member", "memberId", "resolve", {
    note: "@@unique(memberId,seasonYear); a MEANINGFUL loser row colliding with ANY master row for the season is a blocker (payment history is never dropped); a meaningless colliding loser row is dropped, else moved",
  }),
  spec("MembershipSubscriptionCharge", "recipient", "recipientMemberId", "move"),
  spec("MembershipSubscriptionCharge", "confirmedBy", "confirmedByMemberId", "move"),
  spec("MemberSubscription", "manuallyMarkedPaidBy", "manuallyMarkedPaidByMemberId", "move"),
  spec("MembershipBillingException", "member", "memberId", "move"),
  spec("SeasonalMembershipAssignment", "member", "memberId", "resolve", {
    note: "@@unique(memberId,seasonYear); keep master, move non-colliding",
  }),
  spec("SeasonalMembershipAssignment", "assignedBy", "assignedByMemberId", "move"),

  // --- Cancellation ---
  spec("MembershipCancellationRequest", "requestedBy", "requestedByMemberId", "move"),
  spec("MembershipCancellationRequest", "reviewedBy", "reviewedByMemberId", "move"),
  spec("MembershipCancellationRequestParticipant", "member", "memberId", "resolve", {
    note: "@@unique(requestId,memberId)",
  }),
  spec("MembershipCancellationRequestParticipant", "reviewedBy", "reviewedByMemberId", "move"),

  // --- Lifecycle action requests (actor back-refs; memberId itself is snapshot) ---
  spec("MemberLifecycleActionRequest", "requestedBy", "requestedByMemberId", "move"),
  spec("MemberLifecycleActionRequest", "reviewedBy", "reviewedByMemberId", "move"),

  // --- Bookings ---
  spec("Booking", "member", "memberId", "move"),
  spec("Booking", "createdBy", "createdById", "move"),
  spec("Booking", "deletedBy", "deletedById", "move"),
  spec("Booking", "adminReviewedBy", "adminReviewedById", "move"),
  spec("Booking", "adminCapacityHoldBy", "adminCapacityHoldByMemberId", "move"),
  spec("Booking", "capacityOverriddenBy", "capacityOverriddenByMemberId", "move"),
  spec("Booking", "wholeLodgeHoldBy", "wholeLodgeHoldByMemberId", "move"),
  spec("BookingGuest", "member", "memberId", "move"),
  spec("GroupBooking", "organiserMember", "organiserMemberId", "move"),
  spec("GroupBookingJoin", "joinerMember", "joinerMemberId", "resolve", {
    note: "@@unique(groupBookingId,joinerMemberId)",
  }),
  spec("Locker", "allocatedTo", "allocatedToMemberId", "move"),
  spec("BedAllocation", "approvedBy", "approvedByMemberId", "move"),
  spec("BookingChangeRequest", "requestedBy", "requestedByMemberId", "move"),
  spec("BookingChangeRequest", "reviewedBy", "reviewedByMemberId", "move"),

  // --- Promos ---
  spec("PromoRedemption", "member", "memberId", "move"),
  spec("PromoRedemptionAllocation", "member", "memberId", "resolve", {
    note: "@@unique(promoRedemptionId,memberId)+@@unique(promoCodeId,bookingId,memberId)",
  }),
  spec("PromoCodeAssignment", "member", "memberId", "resolve", {
    note: "@@unique(promoCodeId,memberId)",
  }),

  // --- Credits / refunds ---
  spec("MemberCredit", "member", "memberId", "move"),
  spec("MemberCredit", "requestedBy", "requestedById", "move"),
  spec("MemberCredit", "approvedBy", "approvedById", "move"),
  spec("AdminCreditAdjustmentRequest", "member", "memberId", "move"),
  spec("AdminCreditAdjustmentRequest", "requestedBy", "requestedById", "move"),
  spec("AdminCreditAdjustmentRequest", "reviewedBy", "reviewedById", "move"),
  spec("RefundRequest", "member", "memberId", "move"),

  // --- Reports / lodge / hut leader ---
  spec("IssueReport", "member", "memberId", "move"),
  spec("HutLeaderAssignment", "member", "memberId", "move"),
  spec("MemberLodgeAccess", "member", "memberId", "resolve", {
    note: "@@unique(memberId,lodgeId,kind)",
  }),
  spec("MemberLodgeAccess", "createdBy", "createdById", "move"),

  // --- Family ---
  spec("FamilyGroupMember", "member", "memberId", "resolve", {
    note: "@@unique(familyGroupId,memberId); role upgraded to MAX(ADMIN>MEMBER); billing membership re-pointed",
  }),
  spec("FamilyGroupJoinRequest", "invitedMember", "invitedMemberId", "move"),
  spec("FamilyGroupJoinRequest", "linkedMember", "linkedMemberId", "move"),
  spec("FamilyGroupJoinRequest", "subjectMember", "subjectMemberId", "move"),
  spec("FamilyGroupJoinRequest", "requester", "requesterId", "move"),

  // --- Partner links (canonical A<B pair, CONFIRMED partial uniques) ---
  spec("MemberPartnerLink", "memberA", "memberAId", "resolve", {
    note: "@@unique(memberAId,memberBId)+CONFIRMED partial uniques; A<B CHECK; self-pairs/dupes deleted",
  }),
  spec("MemberPartnerLink", "memberB", "memberBId", "resolve", {
    note: "paired with memberA resolver",
  }),
  spec("MemberPartnerLink", "initiatedBy", "initiatedByMemberId", "move"),
  spec("MemberPartnerLink", "confirmedBy", "confirmedByMemberId", "move"),
  spec("MemberPartnerLink", "assignedByAdmin", "assignedByAdminId", "move"),

  // --- Preferences ---
  spec("NotificationPreference", "member", "memberId", "resolve", {
    note: "memberId @unique (1-1); keep master's row, drop loser's",
  }),
  spec("DeletionRequest", "member", "memberId", "move"),

  // --- Committee ---
  spec("CommitteeAssignment", "member", "memberId", "resolve", {
    note: "@@unique(memberId,committeeRoleId)",
  }),
  spec("CommitteeAssignment", "assignedBy", "assignedByMemberId", "move"),

  // --- Inductions ---
  spec("MemberInduction", "member", "memberId", "move", {
    note: "no member unique on main (issue anchor said @@unique(inductionId,memberId); it does not exist) -> plain move",
  }),
  spec("MemberInductionSignOff", "signer", "signerMemberId", "resolve", {
    note: "@@unique(inductionId,signerMemberId); earliest signedAt wins",
  }),
  spec("MemberInductionAssignedSigner", "member", "memberId", "resolve", {
    note: "@@unique(inductionId,memberId); keep master's row",
  }),
];

/**
 * FK-less scalar member-id columns intentionally left pointing at the (deleted)
 * loser as immutable history. Documented here so the cross-check test and
 * reviewers can see they were considered, not missed. NOT relations, so never
 * part of the DMMF/schema relation walk.
 *
 * ILLUSTRATIVE, not exhaustive: the schema carries ~48 FK-less member-id
 * scalars (audit actor/subject columns, reviewedBy snapshots, denormalised
 * name+id pairs like MembershipSubscriptionChargeCoverage.memberId, ...).
 * None of them can silently land in a move/resolve bucket: the completeness
 * test asserts the spec table equals EXACTLY the set of `@relation(fields:)`
 * owner keys, so an FK-less column is structurally excluded from
 * classification (and a test asserts no documented snapshot column overlaps a
 * classified relation column).
 */
export const MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS: readonly string[] = [
  "MemberLifecycleActionRequest.memberId",
  "MemberApplication.nominator1Id",
  "MemberApplication.nominator2Id",
  "MemberApplication.reviewedBy",
  "NominationToken.nominatorMemberId",
  "BookingModification.memberId",
  "IssueReport.resolvedById",
  "IssueReport.screenshotDeletedById",
  "FamilyGroupJoinRequest.reviewedBy",
  "DeletionRequest.reviewedBy",
  "MembershipSubscriptionBillingSettings.updatedByMemberId",
  "MembershipSubscriptionChargeCoverage.memberId",
  "AuditLog.actorMemberId",
  "AuditLog.subjectMemberId",
  "AuditLog.memberId",
];

// ---------------------------------------------------------------------------
// DMMF / schema completeness (the key safety mechanism)
// ---------------------------------------------------------------------------

/**
 * Parse a prisma schema for every Member FK-owning relation field, i.e. every
 * `<field> Member[?] @relation(..., fields: [<col>], ...)` line. Returns the
 * stable `Model.field` keys. This is the authoritative universe the spec table
 * must cover exactly. (Prisma 7's runtime DMMF is trimmed and no longer exposes
 * relationFromFields, so the FK-owner side is read from the schema text; see
 * `memberRelationNamesFromDmmf` for the DMMF cross-check.)
 */
export function parseMemberRelationOwnerKeys(schemaText: string): string[] {
  const lines = schemaText.split(/\r?\n/);
  const keys: string[] = [];
  let model: string | null = null;
  const modelRe = /^model\s+(\w+)\s*\{/;
  // Any singular Member-typed field carrying attributes. The `@relation(...)`
  // is extracted from the attribute tail separately so an attribute BEFORE
  // `@relation(` (e.g. `@ignore @relation(...)`) can never silently exclude a
  // field from the universe (fail-open would let an onDelete:Cascade relation
  // die with the loser unclassified). The runtime-DMMF test additionally
  // asserts every singular Member field maps to a parsed key (fail-closed).
  const fieldRe = /^\s*(\w+)\s+Member\??\s+(@.*)$/;
  for (const line of lines) {
    const mm = line.match(modelRe);
    if (mm) {
      model = mm[1];
      continue;
    }
    if (line.trim() === "}") {
      model = null;
      continue;
    }
    const rm = line.match(fieldRe);
    if (!rm || !model) continue;
    const rel = rm[2].match(/@relation\(([^)]*)\)/);
    if (rel && /fields:\s*\[/.test(rel[1])) {
      keys.push(`${model}.${rm[1]}`);
    }
  }
  return keys;
}

export function diffRelationSpecCoverage(
  ownerKeys: readonly string[],
  specKeys: readonly string[],
): { missing: string[]; extra: string[] } {
  const specSet = new Set(specKeys);
  const ownerSet = new Set(ownerKeys);
  return {
    missing: ownerKeys.filter((k) => !specSet.has(k)).sort(),
    extra: specKeys.filter((k) => !ownerSet.has(k)).sort(),
  };
}

/** All relation names touching Member, from the trimmed runtime DMMF. */
export function memberRelationNamesFromDmmf(
  models: readonly { name: string; fields: readonly { type: string; relationName?: string }[] }[],
): Set<string> {
  const names = new Set<string>();
  for (const model of models) {
    for (const field of model.fields) {
      if (field.type === "Member" && field.relationName) {
        names.add(field.relationName);
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Field-merge policy (master's populated scalars win; blanks filled from loser)
// ---------------------------------------------------------------------------

/** Independent optional scalars filled from the loser only when master is blank. */
const FILL_IF_BLANK_FIELDS = [
  "title",
  "gender",
  "dateOfBirth",
  "occupation",
  "lifeMemberDate",
  "comments",
  "familyGroupId",
] as const;

/** Grouped fills: the whole group comes from the loser only when master's key field is blank. */
const GROUP_FILL_SPECS: { name: string; key: string; fields: string[] }[] = [
  {
    name: "phone",
    key: "phoneNumber",
    fields: ["phoneCountryCode", "phoneAreaCode", "phoneNumber"],
  },
  {
    name: "streetAddress",
    key: "streetAddressLine1",
    fields: [
      "streetAddressLine1",
      "streetAddressLine2",
      "streetCity",
      "streetRegion",
      "streetPostalCode",
      "streetCountry",
    ],
  },
  {
    name: "postalAddress",
    key: "postalAddressLine1",
    fields: [
      "postalAddressLine1",
      "postalAddressLine2",
      "postalCity",
      "postalRegion",
      "postalPostalCode",
      "postalCountry",
    ],
  },
];

export type FieldMergeRow = {
  field: string;
  master: unknown;
  loser: unknown;
  result: unknown;
  source: "master" | "loser" | "or" | "earliest";
};

export type FieldMergeOutcome = {
  patch: Record<string, unknown>;
  diff: FieldMergeRow[];
};

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

function toTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && value) return new Date(value).getTime();
  return null;
}

/**
 * Pure additive field merge. Returns the write patch (only the fields that
 * actually change) plus a full diff for the preview. Auth / login / privilege /
 * Xero identity and onboarding/state fields are NEVER merged — they stay the
 * master's and are not represented in the patch.
 */
export function mergeMemberFields(
  master: Record<string, unknown>,
  loser: Record<string, unknown>,
): FieldMergeOutcome {
  const patch: Record<string, unknown> = {};
  const diff: FieldMergeRow[] = [];

  for (const field of FILL_IF_BLANK_FIELDS) {
    const m = master[field];
    const l = loser[field];
    if (isBlank(m) && !isBlank(l)) {
      patch[field] = l;
      diff.push({ field, master: m, loser: l, result: l, source: "loser" });
    } else {
      diff.push({ field, master: m, loser: l, result: m, source: "master" });
    }
  }

  for (const group of GROUP_FILL_SPECS) {
    const masterHasKey = !isBlank(master[group.key]);
    const loserHasKey = !isBlank(loser[group.key]);
    const takeLoser = !masterHasKey && loserHasKey;
    for (const field of group.fields) {
      const m = master[field];
      const l = loser[field];
      if (takeLoser) {
        patch[field] = l;
        diff.push({ field, master: m, loser: l, result: l, source: "loser" });
      } else {
        diff.push({ field, master: m, loser: l, result: m, source: "master" });
      }
    }
  }

  // OR booleans.
  for (const field of ["requiresInduction", "hutLeaderEligible"] as const) {
    const m = Boolean(master[field]);
    const l = Boolean(loser[field]);
    const result = m || l;
    if (result !== m) patch[field] = result;
    diff.push({ field, master: m, loser: l, result, source: "or" });
  }

  // hutLeaderEligibleAt follows hutLeaderEligible: earliest non-null when eligible.
  {
    const eligible =
      Boolean(master.hutLeaderEligible) || Boolean(loser.hutLeaderEligible);
    const mAt = toTime(master.hutLeaderEligibleAt);
    const lAt = toTime(loser.hutLeaderEligibleAt);
    if (eligible) {
      const earliest =
        mAt === null ? lAt : lAt === null ? mAt : Math.min(mAt, lAt);
      if (earliest !== null && earliest !== mAt) {
        patch.hutLeaderEligibleAt = new Date(earliest);
        diff.push({
          field: "hutLeaderEligibleAt",
          master: master.hutLeaderEligibleAt,
          loser: loser.hutLeaderEligibleAt,
          result: new Date(earliest),
          source: "earliest",
        });
      }
    }
  }

  // joinedDate: earliest membership start date.
  {
    const mAt = toTime(master.joinedDate);
    const lAt = toTime(loser.joinedDate);
    const earliest =
      mAt === null ? lAt : lAt === null ? mAt : Math.min(mAt, lAt);
    if (earliest !== null && earliest !== mAt) {
      patch.joinedDate = new Date(earliest);
    }
    diff.push({
      field: "joinedDate",
      master: master.joinedDate,
      loser: loser.joinedDate,
      result: earliest === null ? null : new Date(earliest),
      source: earliest !== null && earliest === lAt && earliest !== mAt ? "loser" : "master",
    });
  }

  return { patch, diff };
}

// ---------------------------------------------------------------------------
// Partner-link merge plan (pure)
// ---------------------------------------------------------------------------

export type PartnerLinkRow = {
  id: string;
  memberAId: string;
  memberBId: string;
  status: string;
};

export type PartnerLinkPlan = {
  deleteIds: string[];
  updates: { id: string; memberAId: string; memberBId: string }[];
  warnings: string[];
};

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Re-point the loser's partner links onto the master, honouring the
 * `memberAId < memberBId` CHECK, deleting self-pairs and duplicates, and
 * keeping at most one CONFIRMED partner for the master.
 */
export function planPartnerLinkMerge(
  loserLinks: readonly PartnerLinkRow[],
  masterLinks: readonly PartnerLinkRow[],
  masterId: string,
  loserId: string,
): PartnerLinkPlan {
  const deleteIds: string[] = [];
  const updates: { id: string; memberAId: string; memberBId: string }[] = [];
  const warnings: string[] = [];

  // Track master's partners (pairs already present) and confirmed state, folding
  // in each re-pointed loser link so later loser links see the new reality.
  // The master<->loser pair itself is excluded: it becomes a self-pair and is
  // deleted, so a CONFIRMED master<->loser link must NOT count as the master's
  // confirmed partner (a loser's genuine CONFIRMED link to a third member is
  // re-pointed, not dropped).
  const masterPartners = new Set<string>();
  let masterHasConfirmed = false;
  for (const link of masterLinks) {
    const other = link.memberAId === masterId ? link.memberBId : link.memberAId;
    if (other === loserId) continue;
    masterPartners.add(other);
    if (link.status === "CONFIRMED") masterHasConfirmed = true;
  }

  for (const link of loserLinks) {
    const other = link.memberAId === loserId ? link.memberBId : link.memberAId;

    if (other === masterId) {
      // Loser <-> master link becomes a self-pair after re-point.
      deleteIds.push(link.id);
      continue;
    }

    if (masterPartners.has(other)) {
      // Master is already linked to this partner: drop loser's duplicate.
      deleteIds.push(link.id);
      if (link.status === "CONFIRMED") {
        warnings.push(
          `Duplicate partner link with the same member dropped (master already linked).`,
        );
      }
      continue;
    }

    if (link.status === "CONFIRMED" && masterHasConfirmed) {
      // Master already has its one confirmed partner; drop loser's confirmed link.
      deleteIds.push(link.id);
      warnings.push(
        `Loser's confirmed partner link dropped — the master already has a confirmed partner.`,
      );
      continue;
    }

    const [a, b] = canonicalPair(masterId, other);
    updates.push({ id: link.id, memberAId: a, memberBId: b });
    masterPartners.add(other);
    if (link.status === "CONFIRMED") masterHasConfirmed = true;
  }

  return { deleteIds, updates, warnings };
}

// ---------------------------------------------------------------------------
// Family-group role (ADMIN > MEMBER)
// ---------------------------------------------------------------------------

export function maxFamilyRole(a: string, b: string): string {
  return a === "ADMIN" || b === "ADMIN" ? "ADMIN" : "MEMBER";
}

// ---------------------------------------------------------------------------
// Preview token (HMAC over ids + both updatedAt + outcome digest)
// ---------------------------------------------------------------------------

const PREVIEW_TOKEN_VERSION = 1;

function getPreviewSecret(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET or NEXTAUTH_SECRET is required for member merge preview tokens",
    );
  }
  return "member-merge-preview-local-secret";
}

function outcomeDigest(preview: MemberMergePreviewCore): string {
  const canonical = JSON.stringify({
    fieldMerge: preview.fieldMerge.map((r) => ({ f: r.field, r: r.result, s: r.source })),
    relationMoves: preview.relationMoves,
    collisions: preview.collisions,
    blockers: preview.blockers.map((b) => b.code),
  });
  return createHmac("sha256", getPreviewSecret()).update(canonical).digest("hex");
}

function tokenPayload(
  masterId: string,
  loserId: string,
  masterUpdatedAt: Date,
  loserUpdatedAt: Date,
  preview: MemberMergePreviewCore,
): string {
  return JSON.stringify({
    version: PREVIEW_TOKEN_VERSION,
    masterId,
    loserId,
    masterUpdatedAt: masterUpdatedAt.toISOString(),
    loserUpdatedAt: loserUpdatedAt.toISOString(),
    digest: outcomeDigest(preview),
  });
}

export function buildMemberMergePreviewToken(
  masterId: string,
  loserId: string,
  masterUpdatedAt: Date,
  loserUpdatedAt: Date,
  preview: MemberMergePreviewCore,
): string {
  return createHmac("sha256", getPreviewSecret())
    .update(tokenPayload(masterId, loserId, masterUpdatedAt, loserUpdatedAt, preview))
    .digest("hex");
}

function verifyPreviewToken(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Preview types
// ---------------------------------------------------------------------------

export type MergeBlocker = { code: string; label: string; count?: number };

export type MemberMergePreviewCore = {
  fieldMerge: FieldMergeRow[];
  relationMoves: { model: string; count: number }[];
  collisions: { model: string; resolution: string; count: number }[];
  blockers: MergeBlocker[];
  warnings: string[];
};

export type MemberMergePreview = MemberMergePreviewCore & {
  masterId: string;
  loserId: string;
  masterName: string;
  loserName: string;
  confirmationPhrase: string;
  previewToken: string;
};

// ---------------------------------------------------------------------------
// Guards (preview AND re-checked in-transaction)
// ---------------------------------------------------------------------------

type GuardMember = Pick<
  Member,
  "id" | "active" | "archivedAt" | "firstName" | "lastName" | "email"
> & { accessRoles: { role: AccessRole | null }[] };

/** Normalise a confirmation phrase: trim + collapse internal whitespace. */
export function normalizeConfirmationText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function memberMergeConfirmationPhrase(loserName: string): string {
  return `MERGE ${normalizeConfirmationText(loserName)}`;
}

async function countPendingLifecycleOrFamily(
  db: MergeDbClient,
  memberId: string,
): Promise<number> {
  const [lifecycle, family, deletion] = await Promise.all([
    db.memberLifecycleActionRequest.count({
      where: { memberId, status: "REQUESTED" },
    }),
    db.familyGroupJoinRequest.count({
      where: {
        status: "PENDING",
        OR: [
          { requesterId: memberId },
          { invitedMemberId: memberId },
          { linkedMemberId: memberId },
          { subjectMemberId: memberId },
        ],
      },
    }),
    // A PENDING self-service account-deletion request must block the merge:
    // DeletionRequest.member is classified `move`, so without this guard a
    // loser's pending deletion would silently re-point to the master and a
    // later approval would anonymise/wipe the MERGED record (cross-check:
    // MEMBER_DELETE_BLOCKER_SPECS `account_deletion_requests`).
    db.deletionRequest.count({
      where: { memberId, status: "PENDING" },
    }),
  ]);
  return lifecycle + family + deletion;
}

/**
 * Full guard matrix, shared by preview and execute. Returns structured blockers
 * (non-throwing) so the preview can render them; execute throws on any blocker.
 */
export async function evaluateMemberMergeGuards(params: {
  db: MergeDbClient;
  actorMemberId: string;
  master: GuardMember | null;
  loser: GuardMember | null;
  masterId: string;
  loserId: string;
}): Promise<MergeBlocker[]> {
  const { db, actorMemberId, master, loser, masterId, loserId } = params;
  const blockers: MergeBlocker[] = [];

  if (masterId === loserId) {
    blockers.push({ code: "same_member", label: "A member cannot be merged into itself." });
    return blockers;
  }
  if (!master) {
    blockers.push({ code: "master_missing", label: "The master member was not found." });
  }
  if (!loser) {
    blockers.push({ code: "loser_missing", label: "The duplicate member was not found." });
  }
  if (!master || !loser) return blockers;

  if (!(await actorIsFullAdmin(db, actorMemberId))) {
    blockers.push({
      code: "not_full_admin",
      label: "Only a Full Admin can merge member profiles.",
    });
  }

  if (!master.active || master.archivedAt) {
    blockers.push({
      code: "master_inactive",
      label: "The master member must be active and not archived.",
    });
  }

  if (loserId === actorMemberId) {
    blockers.push({
      code: "loser_is_actor",
      label: "You cannot merge your own member record into another.",
    });
  }

  if (hasAdminAccess({ accessRoles: loser.accessRoles })) {
    blockers.push({
      code: "loser_is_admin",
      label: "The duplicate holds an admin access role. Demote it before merging.",
    });
  }
  if (await wouldRemoveLastFullAdmin(db, loserId)) {
    blockers.push({
      code: "loser_last_admin",
      label: "The duplicate is the last Full Admin and cannot be removed.",
    });
  }

  const [masterPending, loserPending] = await Promise.all([
    countPendingLifecycleOrFamily(db, masterId),
    countPendingLifecycleOrFamily(db, loserId),
  ]);
  if (masterPending > 0) {
    blockers.push({
      code: "master_pending_requests",
      label: "The master has pending lifecycle/deletion/family requests. Resolve them first.",
      count: masterPending,
    });
  }
  if (loserPending > 0) {
    blockers.push({
      code: "loser_pending_requests",
      label: "The duplicate has pending lifecycle/deletion/family requests. Resolve them first.",
      count: loserPending,
    });
  }

  // A MEANINGFUL loser subscription (invoiced / paid / charge-covered) that
  // collides with ANY master row for the same season would be dropped by the
  // keep-master resolver — deleting payment history (and a coverage-backed row
  // would surface as a late P2003, MembershipSubscriptionChargeCoverage is
  // onDelete: Restrict). Block regardless of whether the MASTER's row is
  // meaningful: a meaningless master row must never absorb a paid loser row.
  // Only a meaningless colliding loser row may be dropped by the resolver.
  const blockedSeasons = await countBlockedSubscriptionSeasons(db, masterId, loserId);
  if (blockedSeasons > 0) {
    blockers.push({
      code: "subscription_collision",
      label:
        "The duplicate has an invoiced/paid membership subscription for a season the master also has a subscription row for. Resolve the duplicate subscription before merging.",
      count: blockedSeasons,
    });
  }

  return blockers;
}

const MEANINGFUL_SUBSCRIPTION_OR: Prisma.MemberSubscriptionWhereInput["OR"] = [
  { status: { in: ["UNPAID", "PAID", "OVERDUE"] } },
  { xeroInvoiceId: { not: null } },
  { xeroInvoiceNumber: { not: null } },
  { xeroOnlineInvoiceUrl: { not: null } },
  { paidAt: { not: null } },
  { chargeCoverage: { isNot: null } },
];

/**
 * Seasons where a MEANINGFUL loser subscription collides with ANY master
 * subscription row. The master side is deliberately NOT filtered on
 * meaningfulness: the keep-master resolver drops the LOSER's colliding row, so
 * the question is only whether the loser row being dropped carries payment
 * history — not whether the master's surviving row does.
 */
async function countBlockedSubscriptionSeasons(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<number> {
  const [masterAll, loserMeaningful] = await Promise.all([
    db.memberSubscription.findMany({
      where: { memberId: masterId },
      select: { seasonYear: true },
    }),
    db.memberSubscription.findMany({
      where: { memberId: loserId, OR: MEANINGFUL_SUBSCRIPTION_OR },
      select: { seasonYear: true },
    }),
  ]);
  const masterSeasons = new Set(masterAll.map((s) => s.seasonYear));
  return loserMeaningful.filter((s) => masterSeasons.has(s.seasonYear)).length;
}

// ---------------------------------------------------------------------------
// Preview builder
// ---------------------------------------------------------------------------

async function countLoserRows(
  db: MergeDbClient,
  delegate: string,
  column: string,
  loserId: string,
): Promise<number> {
  const model = (db as unknown as Record<string, { count: (args: unknown) => Promise<number> }>)[
    delegate
  ];
  return model.count({ where: { [column]: loserId } });
}

export async function buildMemberMergePreview(params: {
  masterId: string;
  loserId: string;
  actorMemberId: string;
  db?: MergeDbClient;
}): Promise<MemberMergePreview> {
  const db = params.db ?? prisma;
  const { masterId, loserId, actorMemberId } = params;

  const [masterFull, loserFull] = await Promise.all([
    db.member.findUnique({ where: { id: masterId } }),
    db.member.findUnique({ where: { id: loserId } }),
  ]);

  const guardMaster = masterFull ? toGuardMember(masterFull, await loadRoles(db, masterId)) : null;
  const guardLoser = loserFull ? toGuardMember(loserFull, await loadRoles(db, loserId)) : null;

  const blockers = await evaluateMemberMergeGuards({
    db,
    actorMemberId,
    master: guardMaster,
    loser: guardLoser,
    masterId,
    loserId,
  });

  if (!masterFull || !loserFull) {
    throw new MemberMergeError(
      "Both members must exist to preview a merge.",
      404,
      "member_missing",
      { blockers },
    );
  }

  const { diff } = mergeMemberFields(
    masterFull as unknown as Record<string, unknown>,
    loserFull as unknown as Record<string, unknown>,
  );

  const warnings: string[] = [];
  const relationMoves: { model: string; count: number }[] = [];
  const collisions: { model: string; resolution: string; count: number }[] = [];

  // Relation move counts (loser rows that will re-point). Resolve models are
  // reported as collisions with their resolution.
  const moveSpecs = MEMBER_MERGE_RELATION_SPECS.filter((s) => s.bucket === "move");
  const moveCounts = await Promise.all(
    moveSpecs.map((s) => countLoserRows(db, s.delegate, s.column, loserId)),
  );
  moveSpecs.forEach((s, i) => {
    if (moveCounts[i] > 0) relationMoves.push({ model: s.key, count: moveCounts[i] });
  });

  // The loser's own OUTBOUND self-relation columns (parent, inheritEmailFrom,
  // ...) die with the loser: the master keeps its own values and only INBOUND
  // references to the loser are re-pointed. Surface the discard explicitly.
  const discardedSelfRefs = MEMBER_MERGE_RELATION_SPECS.filter(
    (s) => s.selfRelation,
  )
    .filter((s) => {
      const v = (loserFull as unknown as Record<string, unknown>)[s.column];
      return v != null && v !== masterId;
    })
    .map((s) => s.field);
  if (discardedSelfRefs.length > 0) {
    warnings.push(
      `The duplicate's own ${discardedSelfRefs.join(", ")} link(s) are discarded — the master keeps its own (inbound references to the duplicate are still re-pointed).`,
    );
  }

  // Collision previews per resolve model (best-effort counts).
  const resolveSummaries = await summariseResolveCollisions(db, masterId, loserId);
  collisions.push(...resolveSummaries.collisions);
  warnings.push(...resolveSummaries.warnings);

  // Access roles the master will gain (privilege surface — surface explicitly).
  const gainedRoles = await loserAccessRolesGainedByMaster(db, masterId, loserId);
  if (gainedRoles.length > 0) {
    warnings.push(`Master will gain access role(s): ${gainedRoles.join(", ")}.`);
  }

  // Xero warnings.
  const loserXero = await db.xeroObjectLink.findMany({
    where: { localModel: "Member", localId: loserId, active: true },
    select: { role: true },
  });
  if (loserFull.xeroContactId || loserXero.length > 0) {
    warnings.push(
      "Loser's Xero contact remains in Xero — archive or merge it there manually.",
    );
  }
  const loserHasEntranceFee = loserXero.some((l) => l.role === "ENTRANCE_FEE_INVOICE");
  if (loserHasEntranceFee) {
    const masterHasEntranceFee =
      (await db.xeroObjectLink.count({
        where: {
          localModel: "Member",
          localId: masterId,
          active: true,
          role: "ENTRANCE_FEE_INVOICE",
        },
      })) > 0;
    warnings.push(
      masterHasEntranceFee
        ? "Both members have a joining-fee (entrance fee) invoice link; the loser's will be deactivated (master's is kept)."
        : "The loser's joining-fee (entrance fee) invoice link will be re-pointed to the master to preserve paid-fee evidence.",
    );
  }
  warnings.push("The loser will be signed out on their next request.");

  const core: MemberMergePreviewCore = {
    fieldMerge: diff,
    relationMoves,
    collisions,
    blockers,
    warnings,
  };

  const previewToken = buildMemberMergePreviewToken(
    masterId,
    loserId,
    masterFull.updatedAt,
    loserFull.updatedAt,
    core,
  );

  return {
    ...core,
    masterId,
    loserId,
    masterName: memberDisplayName(masterFull),
    loserName: memberDisplayName(loserFull),
    confirmationPhrase: memberMergeConfirmationPhrase(memberDisplayName(loserFull)),
    previewToken,
  };
}

async function loadRoles(db: MergeDbClient, memberId: string) {
  return db.memberAccessRole.findMany({
    where: { memberId },
    select: { role: true },
  });
}

function toGuardMember(
  member: Member,
  accessRoles: { role: AccessRole | null }[],
): GuardMember {
  return {
    id: member.id,
    active: member.active,
    archivedAt: member.archivedAt,
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    accessRoles,
  };
}

/**
 * Access roles the master gains from the loser, INCLUDING definition-backed
 * custom roles (rows with `role = null` and a `roleDefinitionId`), which can
 * grant finance/membership EDIT and must never be an invisible escalation.
 * Tokens mirror `accessRoleTokenFromAssignment` / the Full-Admin gate: the
 * enum value for system/seeded roles, the definition id for custom rows.
 * Returns human-readable labels for the preview warning.
 */
async function loserAccessRolesGainedByMaster(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<string[]> {
  const select = {
    role: true,
    roleDefinitionId: true,
    roleDefinition: { select: { label: true } },
  } as const;
  const [masterRoles, loserRoles] = await Promise.all([
    db.memberAccessRole.findMany({ where: { memberId: masterId }, select }),
    db.memberAccessRole.findMany({ where: { memberId: loserId }, select }),
  ]);
  const tokenOf = (r: {
    role: AccessRole | null;
    roleDefinitionId: string | null;
  }): string | null => r.role ?? r.roleDefinitionId;
  const masterTokens = new Set(
    masterRoles.map(tokenOf).filter((t): t is string => Boolean(t)),
  );
  const gained: string[] = [];
  const seen = new Set<string>();
  for (const r of loserRoles) {
    const token = tokenOf(r);
    if (!token || masterTokens.has(token) || seen.has(token)) continue;
    seen.add(token);
    gained.push(
      r.role ??
        `${r.roleDefinition?.label ?? r.roleDefinitionId} (custom role)`,
    );
  }
  return gained;
}

/**
 * Generic keep-master resolver table, shared by the execute-time resolvers and
 * the preview drop-note summariser so the two can never disagree on keys.
 */
const GENERIC_KEYED_RESOLVERS: readonly {
  spec: string;
  delegate: string;
  memberColumn: string;
  keys: string[][];
}[] = [
  { spec: "MemberAccessRole.member", delegate: "memberAccessRole", memberColumn: "memberId", keys: [["role"], ["roleDefinitionId"]] },
  { spec: "MemberSubscription.member", delegate: "memberSubscription", memberColumn: "memberId", keys: [["seasonYear"]] },
  { spec: "SeasonalMembershipAssignment.member", delegate: "seasonalMembershipAssignment", memberColumn: "memberId", keys: [["seasonYear"]] },
  { spec: "MembershipCancellationRequestParticipant.member", delegate: "membershipCancellationRequestParticipant", memberColumn: "memberId", keys: [["requestId"]] },
  { spec: "GroupBookingJoin.joinerMember", delegate: "groupBookingJoin", memberColumn: "joinerMemberId", keys: [["groupBookingId"]] },
  { spec: "PromoRedemptionAllocation.member", delegate: "promoRedemptionAllocation", memberColumn: "memberId", keys: [["promoRedemptionId"], ["promoCodeId", "bookingId"]] },
  { spec: "PromoCodeAssignment.member", delegate: "promoCodeAssignment", memberColumn: "memberId", keys: [["promoCodeId"]] },
  { spec: "MemberLodgeAccess.member", delegate: "memberLodgeAccess", memberColumn: "memberId", keys: [["lodgeId", "kind"]] },
  { spec: "CommitteeAssignment.member", delegate: "committeeAssignment", memberColumn: "memberId", keys: [["committeeRoleId"]] },
  { spec: "MemberInductionAssignedSigner.member", delegate: "memberInductionAssignedSigner", memberColumn: "memberId", keys: [["inductionId"]] },
  { spec: "NotificationPreference.member", delegate: "notificationPreference", memberColumn: "memberId", keys: [[]] },
];

/**
 * Money/roster resolvers whose dropped duplicates deserve a SPECIFIC preview
 * note: a dropped PromoRedemptionAllocation removes a promo money-allocation
 * row; a dropped GroupBookingJoin removes a group-roster row.
 */
const MONEY_ROSTER_DROP_NOTES: Record<string, string> = {
  "PromoRedemptionAllocation.member":
    "duplicate promo redemption allocation row(s) will be dropped (the master already holds the same allocation) — the dropped rows' promo money history is removed.",
  "GroupBookingJoin.joinerMember":
    "duplicate group-booking join row(s) will be dropped (both members joined the same group booking) — the dropped rows leave that group's roster.",
};

/** Fetch both members' partner links and plan the merge (read-only). */
async function loadPartnerLinkPlan(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<PartnerLinkPlan> {
  const [loserLinks, masterLinks] = await Promise.all([
    db.memberPartnerLink.findMany({
      where: { OR: [{ memberAId: loserId }, { memberBId: loserId }] },
    }),
    db.memberPartnerLink.findMany({
      where: { OR: [{ memberAId: masterId }, { memberBId: masterId }] },
    }),
  ]);
  return planPartnerLinkMerge(loserLinks, masterLinks, masterId, loserId);
}

async function summariseResolveCollisions(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<{ collisions: { model: string; resolution: string; count: number }[]; warnings: string[] }> {
  const collisions: { model: string; resolution: string; count: number }[] = [];
  const warnings: string[] = [];

  const specs = MEMBER_MERGE_RELATION_SPECS.filter(
    // Both partner-link sides are summarised together via the planner below.
    (s) => s.bucket === "resolve" && s.model !== "MemberPartnerLink",
  );
  const counts = await Promise.all(
    specs.map((s) => countLoserRows(db, s.delegate, s.column, loserId)),
  );
  specs.forEach((s, i) => {
    if (counts[i] > 0) {
      collisions.push({ model: s.key, resolution: s.note ?? "dedupe on unique key", count: counts[i] });
    }
  });

  // Specific drop notes for money/roster rows (actual collisions, not just
  // loser-row counts).
  for (const g of GENERIC_KEYED_RESOLVERS) {
    const note = MONEY_ROSTER_DROP_NOTES[g.spec];
    if (!note) continue;
    const delegate = (db as unknown as Record<string, {
      findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
    }>)[g.delegate];
    const [loserRows, masterRows] = await Promise.all([
      delegate.findMany({ where: { [g.memberColumn]: loserId } }),
      delegate.findMany({ where: { [g.memberColumn]: masterId } }),
    ]);
    if (loserRows.length === 0) continue;
    const { dropIds } = partitionKeyedCollisions(loserRows, masterRows, g.keys);
    if (dropIds.length > 0) {
      warnings.push(`${dropIds.length} ${note}`);
    }
  }

  // Partner links: run the planner read-only so BOTH sides of the pair are
  // counted and CONFIRMED-drop warnings surface in the preview.
  const partnerPlan = await loadPartnerLinkPlan(db, masterId, loserId);
  const partnerTotal = partnerPlan.updates.length + partnerPlan.deleteIds.length;
  if (partnerTotal > 0) {
    collisions.push({
      model: "MemberPartnerLink.memberA/memberB",
      resolution: `re-point ${partnerPlan.updates.length}, drop ${partnerPlan.deleteIds.length} (self-pair/duplicate/confirmed)`,
      count: partnerTotal,
    });
  }
  warnings.push(...partnerPlan.warnings);

  return { collisions, warnings };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

const MOVED_ID_SAMPLE_CAP = 500;

export type MemberMergeResult = {
  masterId: string;
  loserId: string;
  relationMoves: { model: string; count: number }[];
  collisions: { model: string; resolution: string; count: number }[];
  fieldsChanged: string[];
};

export async function executeMemberMerge(params: {
  masterId: string;
  loserId: string;
  actorMemberId: string;
  previewToken: string;
  confirmationText: string;
  request?: Request;
  db?: typeof prisma;
}): Promise<MemberMergeResult> {
  const client = params.db ?? prisma;
  const { masterId, loserId, actorMemberId } = params;

  if (masterId === loserId) {
    throw new MemberMergeError("A member cannot be merged into itself.", 400, "same_member");
  }

  return client.$transaction(async (tx) => {
    // Dual advisory lock in sorted id order (deadlock-free) on the shared
    // member-lifecycle key space, so a merge serialises with any concurrent
    // delete/archive/merge touching either member.
    const [lockA, lockB] = [masterId, loserId].sort();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-lifecycle:${lockA}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-lifecycle:${lockB}`}))`;

    const [masterFull, loserFull] = await Promise.all([
      tx.member.findUnique({ where: { id: masterId } }),
      tx.member.findUnique({ where: { id: loserId } }),
    ]);
    if (!masterFull || !loserFull) {
      throw new MemberMergeError("Both members must exist to merge.", 404, "member_missing");
    }

    const guardMaster = toGuardMember(masterFull, await loadRoles(tx, masterId));
    const guardLoser = toGuardMember(loserFull, await loadRoles(tx, loserId));
    const blockers = await evaluateMemberMergeGuards({
      db: tx,
      actorMemberId,
      master: guardMaster,
      loser: guardLoser,
      masterId,
      loserId,
    });
    if (blockers.length > 0) {
      throw new MemberMergeError(
        "This merge is blocked.",
        409,
        "merge_blocked",
        { blockers },
      );
    }

    // Confirmation phrase (authoritative loser name from the reloaded record).
    const expectedPhrase = memberMergeConfirmationPhrase(memberDisplayName(loserFull));
    if (normalizeConfirmationText(params.confirmationText) !== expectedPhrase) {
      throw new MemberMergeError(
        `Type "${expectedPhrase}" to confirm the merge.`,
        422,
        "confirmation_mismatch",
      );
    }

    // Re-verify the preview token against the CURRENT state (updatedAt of both
    // records is baked in, so any concurrent edit invalidates the token: 409).
    const fieldOutcome = mergeMemberFields(
      masterFull as unknown as Record<string, unknown>,
      loserFull as unknown as Record<string, unknown>,
    );
    const relationMoveCountsPreview = await previewRelationCountsForToken(tx, masterId, loserId);
    const collisionsPreview = (await summariseResolveCollisions(tx, masterId, loserId)).collisions;
    const core: MemberMergePreviewCore = {
      fieldMerge: fieldOutcome.diff,
      relationMoves: relationMoveCountsPreview,
      collisions: collisionsPreview,
      blockers: [],
      warnings: [],
    };
    const expectedToken = buildMemberMergePreviewToken(
      masterId,
      loserId,
      masterFull.updatedAt,
      loserFull.updatedAt,
      core,
    );
    if (!verifyPreviewToken(expectedToken, params.previewToken)) {
      throw new MemberMergeError(
        "The member records changed since the preview. Re-run the preview and try again.",
        409,
        "preview_drift",
      );
    }

    // Collect a bounded moved-id sample BEFORE mutating.
    const movedIdSample = await collectMovedIdSample(tx, loserId);

    // 1) Null master self-relation cycles first.
    await nullSelfRelationCycles(tx, masterFull, loserId);

    // 2) Resolve collisions.
    const resolveResults = await resolveAllCollisions(tx, masterId, loserId);

    // 3) Moves.
    const relationMoves = await applyMoves(tx, masterId, loserId);

    // 4) Loser Xero teardown (link-role aware; NO Xero API calls).
    const xeroTeardown = await teardownLoserXero(tx, masterId, loserId);

    // 5) Field merge.
    const fieldsChanged = Object.keys(fieldOutcome.patch);
    if (fieldsChanged.length > 0) {
      await tx.member.update({ where: { id: masterId }, data: fieldOutcome.patch });
    }

    // 6) One critical audit.
    const loserSnapshot = buildLoserSnapshot(loserFull);
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBER_MERGED",
        actor: { memberId: actorMemberId },
        subject: { memberId: masterId },
        entity: { type: "Member", id: masterId },
        category: "admin",
        severity: "critical",
        outcome: "success",
        summary: "Member profiles merged (loser hard-deleted)",
        metadata: {
          masterId,
          loserId,
          loserSnapshot,
          fieldOutcome: fieldOutcome.diff,
          fieldsChanged,
          relationMoves,
          collisions: resolveResults.collisions,
          resolutionWarnings: resolveResults.warnings,
          xeroTeardown,
          movedIdSample: movedIdSample.sample,
          movedIdSampleTruncated: movedIdSample.truncated,
        },
        request: params.request ? getRequestContext(params.request) : undefined,
      }),
    );

    // 7) Hard-delete the loser (cascade drops its auth/token rows).
    await tx.member.delete({ where: { id: loserId } });

    return {
      masterId,
      loserId,
      relationMoves,
      collisions: resolveResults.collisions,
      fieldsChanged,
    };
  }, {
    // A merge does hundreds of sequential round-trips (per-relation counts,
    // collision resolvers, moves) over 70+ relations; the 5s default would
    // P2028 exactly on the heavy members most likely to need merging. The dual
    // advisory lock serialises concurrent lifecycle writers, so a long window
    // is safe here.
    timeout: 120_000,
    maxWait: 10_000,
  });
}

function getRequestContext(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  const parts = forwarded?.split(",").map((p) => p.trim()).filter(Boolean);
  return {
    id: request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
    ipAddress:
      parts?.[parts.length - 1] ?? request.headers.get("x-real-ip") ?? "unknown",
    userAgent: request.headers.get("user-agent"),
  };
}

function buildLoserSnapshot(loser: Member) {
  return {
    id: loser.id,
    firstName: loser.firstName,
    lastName: loser.lastName,
    email: loser.email,
    xeroContactId: loser.xeroContactId,
    joinedDate: loser.joinedDate?.toISOString() ?? null,
    createdAt: loser.createdAt.toISOString(),
  };
}

async function previewRelationCountsForToken(
  db: MergeDbClient,
  masterId: string,
  loserId: string,
): Promise<{ model: string; count: number }[]> {
  const out: { model: string; count: number }[] = [];
  const moveSpecs = MEMBER_MERGE_RELATION_SPECS.filter((s) => s.bucket === "move");
  const counts = await Promise.all(
    moveSpecs.map((s) => countLoserRows(db, s.delegate, s.column, loserId)),
  );
  moveSpecs.forEach((s, i) => {
    if (counts[i] > 0) out.push({ model: s.key, count: counts[i] });
  });
  return out;
}

async function collectMovedIdSample(
  db: MergeDbClient,
  loserId: string,
): Promise<{ sample: { model: string; id: string }[]; truncated: boolean }> {
  const sample: { model: string; id: string }[] = [];
  let truncated = false;
  for (const s of MEMBER_MERGE_RELATION_SPECS) {
    if (s.bucket === "cascade") continue;
    if (sample.length >= MOVED_ID_SAMPLE_CAP) {
      truncated = true;
      break;
    }
    const delegate = (db as unknown as Record<string, {
      findMany: (args: unknown) => Promise<{ id: string }[]>;
    }>)[s.delegate];
    const remaining = MOVED_ID_SAMPLE_CAP - sample.length;
    const rows = await delegate.findMany({
      where: { [s.column]: loserId },
      select: { id: true },
      take: remaining + 1,
    });
    for (const r of rows.slice(0, remaining)) {
      sample.push({ model: s.key, id: r.id });
    }
    if (rows.length > remaining) truncated = true;
  }
  return { sample, truncated };
}

async function nullSelfRelationCycles(
  tx: Prisma.TransactionClient,
  master: Member,
  loserId: string,
): Promise<void> {
  const data: Record<string, null> = {};
  for (const s of MEMBER_MERGE_RELATION_SPECS) {
    if (!s.selfRelation) continue;
    if ((master as unknown as Record<string, unknown>)[s.column] === loserId) {
      data[s.column] = null;
    }
  }
  if (Object.keys(data).length > 0) {
    await tx.member.update({ where: { id: master.id }, data });
  }
}

async function applyMoves(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
): Promise<{ model: string; count: number }[]> {
  const moves: { model: string; count: number }[] = [];
  for (const s of MEMBER_MERGE_RELATION_SPECS) {
    if (s.bucket !== "move") continue;
    const delegate = (tx as unknown as Record<string, {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    }>)[s.delegate];
    const res = await delegate.updateMany({
      where: { [s.column]: loserId },
      data: { [s.column]: masterId },
    });
    if (res.count > 0) moves.push({ model: s.key, count: res.count });
  }
  return moves;
}

// ---------------------------------------------------------------------------
// Collision resolvers (execute-time)
// ---------------------------------------------------------------------------

type ResolveOutcome = {
  collisions: { model: string; resolution: string; count: number }[];
  warnings: string[];
};

async function resolveAllCollisions(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
): Promise<ResolveOutcome> {
  const collisions: { model: string; resolution: string; count: number }[] = [];
  const warnings: string[] = [];

  for (const g of GENERIC_KEYED_RESOLVERS) {
    const res = await resolveKeyedCollisions(tx, {
      delegate: g.delegate,
      memberColumn: g.memberColumn,
      keySpecs: g.keys,
      masterId,
      loserId,
    });
    if (res.moved + res.dropped > 0) {
      collisions.push({
        model: g.spec,
        resolution: `moved ${res.moved}, dropped ${res.dropped} duplicate(s)`,
        count: res.moved + res.dropped,
      });
    }
  }

  // FamilyGroupMember (role MAX + billing membership re-point).
  const fgm = await resolveFamilyGroupMembers(tx, masterId, loserId);
  if (fgm.moved + fgm.dropped > 0) {
    collisions.push({
      model: "FamilyGroupMember.member",
      resolution: `moved ${fgm.moved}, merged ${fgm.dropped} duplicate group(s) (role -> MAX)`,
      count: fgm.moved + fgm.dropped,
    });
  }

  // MemberInductionSignOff (earliest-wins).
  const iso = await resolveInductionSignOffs(tx, masterId, loserId);
  if (iso.moved + iso.dropped > 0) {
    collisions.push({
      model: "MemberInductionSignOff.signer",
      resolution: `moved ${iso.moved}, dropped ${iso.dropped} (earliest sign-off kept)`,
      count: iso.moved + iso.dropped,
    });
  }

  // MemberPartnerLink (canonical pair, self-pair/dupe/confirmed handling).
  const partner = await resolvePartnerLinks(tx, masterId, loserId);
  if (partner.updated + partner.deleted > 0) {
    collisions.push({
      model: "MemberPartnerLink.memberA/memberB",
      resolution: `re-pointed ${partner.updated}, dropped ${partner.deleted} (self-pair/duplicate/confirmed)`,
      count: partner.updated + partner.deleted,
    });
  }
  warnings.push(...partner.warnings);

  return { collisions, warnings };
}

async function resolveKeyedCollisions(
  tx: Prisma.TransactionClient,
  args: {
    delegate: string;
    memberColumn: string;
    keySpecs: string[][];
    masterId: string;
    loserId: string;
  },
): Promise<{ moved: number; dropped: number }> {
  const delegate = (tx as unknown as Record<string, {
    findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
    deleteMany: (a: unknown) => Promise<{ count: number }>;
    updateMany: (a: unknown) => Promise<{ count: number }>;
  }>)[args.delegate];

  const [loserRows, masterRows] = await Promise.all([
    delegate.findMany({ where: { [args.memberColumn]: args.loserId } }),
    delegate.findMany({ where: { [args.memberColumn]: args.masterId } }),
  ]);
  if (loserRows.length === 0) return { moved: 0, dropped: 0 };

  const { dropIds, moveIds } = partitionKeyedCollisions(
    loserRows,
    masterRows,
    args.keySpecs,
  );

  if (dropIds.length > 0) {
    await delegate.deleteMany({ where: { id: { in: dropIds } } });
  }
  await delegate.updateMany({
    where: { [args.memberColumn]: args.loserId },
    data: { [args.memberColumn]: args.masterId },
  });

  return { moved: moveIds.length, dropped: dropIds.length };
}

/**
 * The composite key for one unique over `fields`, or `null` when any component
 * is null/undefined. A null component means SQL treats the row as distinct on
 * that unique (NULLs never collide), so such a row is never a duplicate on that
 * key - critical for `MemberAccessRole`, whose `role`/`roleDefinitionId` are
 * both nullable (two custom-role rows both carry `role = null` yet are distinct).
 */
function keyOf(row: Record<string, unknown>, fields: readonly string[]): string | null {
  const parts: string[] = [];
  for (const f of fields) {
    const v = row[f];
    if (v === null || v === undefined) return null;
    parts.push(String(v));
  }
  return parts.join("\u0000");
}

/**
 * Pure keep-master collision partition: a loser row is dropped when it collides
 * with a master row on ANY of the model unique keys (the member column is
 * excluded from the key because it becomes the master's after re-point). Every
 * with a null component never collides (SQL NULL-distinct semantics). Every
 * other loser row is moved. Covers the collision matrix: both-have (drop),
 * loser-only (move), neither (nothing to do).
 */
export function partitionKeyedCollisions(
  loserRows: readonly Record<string, unknown>[],
  masterRows: readonly Record<string, unknown>[],
  keySpecs: readonly (readonly string[])[],
): { dropIds: string[]; moveIds: string[] } {
  const masterKeySets = keySpecs.map((fields) => {
    const set = new Set<string>();
    for (const r of masterRows) {
      const k = keyOf(r, fields);
      if (k !== null) set.add(k);
    }
    return set;
  });
  const dropIds: string[] = [];
  const moveIds: string[] = [];
  for (const row of loserRows) {
    const collides = keySpecs.some((fields, i) => {
      const k = keyOf(row, fields);
      return k !== null && masterKeySets[i].has(k);
    });
    if (collides) dropIds.push(row.id as string);
    else moveIds.push(row.id as string);
  }
  return { dropIds, moveIds };
}

async function resolveFamilyGroupMembers(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
): Promise<{ moved: number; dropped: number }> {
  const [loserRows, masterRows] = await Promise.all([
    tx.familyGroupMember.findMany({ where: { memberId: loserId } }),
    tx.familyGroupMember.findMany({ where: { memberId: masterId } }),
  ]);
  if (loserRows.length === 0) return { moved: 0, dropped: 0 };
  const masterByGroup = new Map(masterRows.map((r) => [r.familyGroupId, r]));

  const dropIds: string[] = [];
  for (const row of loserRows) {
    const masterRow = masterByGroup.get(row.familyGroupId);
    if (!masterRow) continue; // no collision -> will be moved
    // Upgrade master's role to the max, and re-point the family's billing
    // membership if it pointed at the loser's (about-to-be-dropped) row.
    const upgraded = maxFamilyRole(masterRow.role, row.role);
    if (upgraded !== masterRow.role) {
      await tx.familyGroupMember.update({
        where: { id: masterRow.id },
        data: { role: upgraded },
      });
    }
    await tx.familyGroup.updateMany({
      where: { billingMembershipId: row.id },
      data: { billingMembershipId: masterRow.id },
    });
    dropIds.push(row.id);
  }

  if (dropIds.length > 0) {
    await tx.familyGroupMember.deleteMany({ where: { id: { in: dropIds } } });
  }
  const moved = await tx.familyGroupMember.updateMany({
    where: { memberId: loserId },
    data: { memberId: masterId },
  });
  return { moved: moved.count, dropped: dropIds.length };
}

async function resolveInductionSignOffs(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
): Promise<{ moved: number; dropped: number }> {
  const [loserRows, masterRows] = await Promise.all([
    tx.memberInductionSignOff.findMany({ where: { signerMemberId: loserId } }),
    tx.memberInductionSignOff.findMany({ where: { signerMemberId: masterId } }),
  ]);
  if (loserRows.length === 0) return { moved: 0, dropped: 0 };
  const masterByInduction = new Map(masterRows.map((r) => [r.inductionId, r]));

  let dropped = 0;
  for (const row of loserRows) {
    const masterRow = masterByInduction.get(row.inductionId);
    if (!masterRow) continue;
    // Earliest sign-off wins.
    if (row.signedAt.getTime() < masterRow.signedAt.getTime()) {
      // Loser's is earlier: drop master's, keep loser's (moved below).
      await tx.memberInductionSignOff.delete({ where: { id: masterRow.id } });
      masterByInduction.delete(row.inductionId);
    } else {
      await tx.memberInductionSignOff.delete({ where: { id: row.id } });
      dropped += 1;
    }
  }
  const moved = await tx.memberInductionSignOff.updateMany({
    where: { signerMemberId: loserId },
    data: { signerMemberId: masterId },
  });
  return { moved: moved.count, dropped };
}

async function resolvePartnerLinks(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
): Promise<{ updated: number; deleted: number; warnings: string[] }> {
  const plan = await loadPartnerLinkPlan(tx, masterId, loserId);
  if (plan.deleteIds.length > 0) {
    await tx.memberPartnerLink.deleteMany({ where: { id: { in: plan.deleteIds } } });
  }
  for (const u of plan.updates) {
    await tx.memberPartnerLink.update({
      where: { id: u.id },
      data: { memberAId: u.memberAId, memberBId: u.memberBId },
    });
  }
  return {
    updated: plan.updates.length,
    deleted: plan.deleteIds.length,
    warnings: plan.warnings,
  };
}

// ---------------------------------------------------------------------------
// Loser Xero teardown (link-role aware; NO Xero API calls)
// ---------------------------------------------------------------------------

async function teardownLoserXero(
  tx: Prisma.TransactionClient,
  masterId: string,
  loserId: string,
): Promise<{ entranceFee: "repointed" | "deactivated" | "none"; deactivatedOther: number }> {
  const loserLinks = await tx.xeroObjectLink.findMany({
    where: { localModel: "Member", localId: loserId, active: true },
  });

  let entranceFee: "repointed" | "deactivated" | "none" = "none";
  const entranceLink = loserLinks.find((l) => l.role === "ENTRANCE_FEE_INVOICE");

  if (entranceLink) {
    const masterHasEntrance =
      (await tx.xeroObjectLink.count({
        where: {
          localModel: "Member",
          localId: masterId,
          active: true,
          role: "ENTRANCE_FEE_INVOICE",
        },
      })) > 0;

    // The (localModel,localId,xeroObjectType,xeroObjectId,role) unique means a
    // re-point could collide if the master already holds the identical link; in
    // that case (or if the master already has any active entrance-fee link) we
    // deactivate the loser's instead of re-pointing.
    const masterHasIdentical =
      (await tx.xeroObjectLink.count({
        where: {
          localModel: "Member",
          localId: masterId,
          xeroObjectType: entranceLink.xeroObjectType,
          xeroObjectId: entranceLink.xeroObjectId,
          role: "ENTRANCE_FEE_INVOICE",
        },
      })) > 0;

    if (masterHasEntrance || masterHasIdentical) {
      await tx.xeroObjectLink.update({
        where: { id: entranceLink.id },
        data: { active: false },
      });
      entranceFee = "deactivated";
    } else {
      await tx.xeroObjectLink.update({
        where: { id: entranceLink.id },
        data: { localId: masterId },
      });
      entranceFee = "repointed";
    }
  }

  // Deactivate every OTHER active contact-identity link for the loser (mirror
  // of the delete path). The entrance-fee link was handled above.
  const deactivated = await tx.xeroObjectLink.updateMany({
    where: {
      localModel: "Member",
      localId: loserId,
      active: true,
      role: { not: "ENTRANCE_FEE_INVOICE" },
    },
    data: { active: false },
  });

  // Mirror the delete path: null the loser's Xero contact id (loser is deleted
  // straight after, but keep behaviour identical and defensive).
  await tx.member.update({ where: { id: loserId }, data: { xeroContactId: null } });

  return { entranceFee, deactivatedOther: deactivated.count };
}
