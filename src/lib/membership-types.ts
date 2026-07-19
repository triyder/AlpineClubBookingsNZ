import type {
  AgeTier,
  MembershipTypeBookingBehavior,
  MembershipTypeSubscriptionBehavior,
  Prisma,
  Role,
} from "@prisma/client";
import { getSeasonYear } from "@/lib/utils";

const MEMBERSHIP_TYPE_KEY_MAX_LENGTH = 80;

export const MEMBERSHIP_TYPE_BOOKING_BEHAVIORS = [
  "MEMBER_RATE",
  "NON_MEMBER_RATE",
  "BLOCK_BOOKING",
] as const satisfies readonly MembershipTypeBookingBehavior[];

export const MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS = [
  "REQUIRED",
  "NOT_REQUIRED",
  "BASED_ON_AGE_TIER",
] as const satisfies readonly MembershipTypeSubscriptionBehavior[];

// Age tiers an admin can tick as "allowed" for a membership type. Includes the
// explicit "N/A (no age)" option (NOT_APPLICABLE, sorted last) so
// organisation/school types can be configured as age-exempt (#2069). This feeds
// the create/update zod enums, the normalizer, and the dialog checkbox list.
export const MEMBERSHIP_TYPE_AGE_TIERS = [
  "INFANT",
  "CHILD",
  "YOUTH",
  "ADULT",
  "NOT_APPLICABLE",
] as const satisfies readonly AgeTier[];

// The default allowed-tier set for a new membership type when the caller omits
// allowedAgeTiers. Deliberately the four real age tiers only — N/A is opt-in and
// must never be pre-selected or silently added to a default (#2069).
export const DEFAULT_MEMBERSHIP_TYPE_AGE_TIERS = [
  "INFANT",
  "CHILD",
  "YOUTH",
  "ADULT",
] as const satisfies readonly AgeTier[];

export const BUILT_IN_MEMBERSHIP_TYPES = [
  {
    key: "FULL",
    name: "Full",
    description: "Default full club membership.",
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 0,
  },
  {
    key: "ASSOCIATE",
    name: "Associate",
    description:
      "Associate or reserve-style membership. Clubs can rename this label without changing policy.",
    bookingBehavior: "NON_MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 1,
  },
  {
    key: "LIFE",
    name: "Life",
    description:
      "Life membership starts with member booking-rate policy and no Annual Membership Fee requirement.",
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "NOT_REQUIRED",
    sortOrder: 2,
  },
  {
    key: "SCHOOL",
    name: "School",
    description:
      "School or education-organisation booking contact. Does not grant member access or Annual Membership Fee obligations.",
    bookingBehavior: "NON_MEMBER_RATE",
    subscriptionBehavior: "NOT_REQUIRED",
    sortOrder: 3,
  },
  {
    key: "NON_MEMBER",
    name: "Non-Member",
    description:
      "General public or guest contact. Does not grant member access or Annual Membership Fee obligations.",
    bookingBehavior: "NON_MEMBER_RATE",
    subscriptionBehavior: "NOT_REQUIRED",
    sortOrder: 4,
  },
  {
    key: "FAMILY",
    name: "Family",
    description:
      "Membership granted through a family subscription or explicit family assignment.",
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 5,
  },
] as const satisfies ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  bookingBehavior: MembershipTypeBookingBehavior;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior;
  sortOrder: number;
}>;

const BUILT_IN_MEMBERSHIP_TYPE_KEYS = BUILT_IN_MEMBERSHIP_TYPES.map(
  (type) => type.key,
);

export type BuiltInMembershipTypeKey =
  (typeof BUILT_IN_MEMBERSHIP_TYPES)[number]["key"];

const LEGACY_MEMBERSHIP_TYPE_KEY_ALIASES = {
  RESERVE: "ASSOCIATE",
} as const satisfies Record<string, BuiltInMembershipTypeKey>;
const LEGACY_MEMBERSHIP_TYPE_KEY_ALIAS_MAP: Record<
  string,
  BuiltInMembershipTypeKey
> = LEGACY_MEMBERSHIP_TYPE_KEY_ALIASES;

const BUILT_IN_MEMBERSHIP_TYPE_ALLOWED_AGE_TIERS = {
  FULL: ["INFANT", "CHILD", "YOUTH", "ADULT"],
  ASSOCIATE: ["ADULT"],
  LIFE: ["ADULT"],
  SCHOOL: ["CHILD", "YOUTH", "ADULT"],
  NON_MEMBER: ["INFANT", "CHILD", "YOUTH", "ADULT"],
  FAMILY: ["INFANT", "CHILD", "YOUTH", "ADULT"],
} as const satisfies Record<BuiltInMembershipTypeKey, readonly AgeTier[]>;

export function normalizeMembershipTypeAgeTiers(
  ageTiers: readonly AgeTier[],
): AgeTier[] {
  const requested = new Set(ageTiers);
  return MEMBERSHIP_TYPE_AGE_TIERS.filter((ageTier) => requested.has(ageTier));
}

// Age-exemption classification of a membership type, derived purely from its
// configured `allowedAgeTiers` (#2106). This is the single source that decides
// whether a member on the type is forced to the no-age N/A tier, may hand-pick
// it, or may never hold it:
//   FORCED     — the set is EXACTLY {NOT_APPLICABLE}; every member on the type
//                carries N/A (mirrors the org/school force, but driven by type).
//   ALLOWED    — N/A appears alongside one or more real person tiers, so an
//                admin can hand-pick N/A per member while others keep a real
//                tier.
//   DISALLOWED — N/A is absent; no member on the type may hold it.
// `ageGroupsApply` (a pricing-shape flag) is deliberately NOT consulted.
export type MembershipTypeAgeExemption = "FORCED" | "ALLOWED" | "DISALLOWED";

export function membershipTypeAgeExemption(
  allowedAgeTiers: readonly AgeTier[] | null | undefined,
): MembershipTypeAgeExemption {
  const tiers = allowedAgeTiers ?? [];
  const includesNotApplicable = tiers.includes("NOT_APPLICABLE");
  if (!includesNotApplicable) {
    return "DISALLOWED";
  }
  const includesPersonTier = tiers.some((tier) => tier !== "NOT_APPLICABLE");
  return includesPersonTier ? "ALLOWED" : "FORCED";
}

export function validateMembershipTypeRuleConfiguration(params: {
  allowedAgeTiers: readonly AgeTier[];
  subscriptionBehavior?: MembershipTypeSubscriptionBehavior;
}): string | null {
  if (params.allowedAgeTiers.length === 0) {
    return "Select at least one allowed age tier.";
  }
  // Owner decision (#2106): the age-exempt N/A option must never bypass the
  // subscription lockout on a paying type. N/A members are exempt from every
  // age-based subscription requirement, so a type that offers N/A (FORCED or
  // ALLOWED) is only valid when its subscription behaviour is "not required".
  if (
    params.subscriptionBehavior !== undefined &&
    params.allowedAgeTiers.includes("NOT_APPLICABLE") &&
    params.subscriptionBehavior !== "NOT_REQUIRED"
  ) {
    return 'The "N/A (no age)" tier is only allowed on membership types whose subscription behaviour is "not required".';
  }
  return null;
}

// Owner decision (#2106): a membership-type allowed-tiers edit is blocked while
// current/future-season assignments on the type would be stranded by the change.
// Two independent stranding cases are covered (either one blocks):
//   1. Becoming FORCED (only-N/A) — offends every member currently on a real
//      person tier (they cannot silently be force-flipped to N/A; reassign or
//      reclassify them first).
//   2. Removing N/A from the allowed set (FORCED→DISALLOWED *and* the
//      ALLOWED→DISALLOWED stranding the earlier guard missed) — offends every
//      NON-ORG member currently on N/A. Organisation members are exempt: the org
//      force keeps them N/A globally regardless of the type's tiers (#1440), so
//      dropping N/A never strands them.
// When neither case applies (e.g. FORCED→ALLOWED keeps N/A; an ordinary
// person-tier narrowing that neither creates FORCED nor removes N/A) this
// returns an empty list.
export function membershipTypeForcedEditOffendingTiers(params: {
  previousAllowedAgeTiers: readonly AgeTier[];
  nextAllowedAgeTiers: readonly AgeTier[];
  affectedMembers: readonly { ageTier: AgeTier; isOrganisation: boolean }[];
}): AgeTier[] {
  const nextAllowed = new Set(params.nextAllowedAgeTiers);
  const previous = membershipTypeAgeExemption(params.previousAllowedAgeTiers);
  const next = membershipTypeAgeExemption(params.nextAllowedAgeTiers);
  const createsForced = previous !== "FORCED" && next === "FORCED";
  const removesNotApplicable =
    params.previousAllowedAgeTiers.includes("NOT_APPLICABLE") &&
    !nextAllowed.has("NOT_APPLICABLE");
  if (!createsForced && !removesNotApplicable) {
    return [];
  }
  const offending = new Set<AgeTier>();
  for (const member of params.affectedMembers) {
    if (member.ageTier === "NOT_APPLICABLE") {
      // Dropping N/A strands a non-org member currently on N/A; org members are
      // exempt (global org force keeps them N/A regardless of the type).
      if (removesNotApplicable && !member.isOrganisation) {
        offending.add("NOT_APPLICABLE");
      }
      continue;
    }
    // A real person tier the new set does not cover strands the member. Only
    // reachable when becoming FORCED (only-N/A excludes every real tier); an
    // ordinary allowed-tier narrowing is out of scope for this guard.
    if (createsForced && !nextAllowed.has(member.ageTier)) {
      offending.add(member.ageTier);
    }
  }
  return [...offending];
}

export async function replaceMembershipTypeRuleConfiguration(
  db: Pick<Prisma.TransactionClient, "membershipTypeAgeTier">,
  membershipTypeId: string,
  config: {
    allowedAgeTiers?: readonly AgeTier[];
  },
): Promise<void> {
  if (config.allowedAgeTiers !== undefined) {
    await db.membershipTypeAgeTier.deleteMany({ where: { membershipTypeId } });
    if (config.allowedAgeTiers.length > 0) {
      await db.membershipTypeAgeTier.createMany({
        data: config.allowedAgeTiers.map((ageTier) => ({
          membershipTypeId,
          ageTier,
        })),
        skipDuplicates: true,
      });
    }
  }
}

type MembershipTypeWithAssignmentCount = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  publicDescription: string | null;
  publiclyListed: boolean;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: MembershipTypeBookingBehavior;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior;
  ageGroupsApply?: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  allowedAgeTiers?: Array<{ ageTier: AgeTier }>;
  _count?: {
    assignments: number;
    annualFees?: number;
  };
};

interface MembershipTypeSeedClient {
  membershipType: {
    upsert(args: {
      where: { key: string };
      update: Record<string, never>;
      create: {
        key: string;
        name: string;
        description: string;
        isActive: true;
        isBuiltIn: true;
        bookingBehavior: MembershipTypeBookingBehavior;
        subscriptionBehavior: MembershipTypeSubscriptionBehavior;
        sortOrder: number;
      };
    }): Promise<unknown>;
    findMany(args: {
      where: { key: { in: string[] } };
      select: { id: true; key: true };
    }): Promise<Array<{ id: string; key: string }>>;
  };
  member: {
    findMany(args: {
      select: { id: true; role: true };
    }): Promise<Array<{ id: string; role: Role }>>;
  };
  seasonalMembershipAssignment: {
    createMany(args: {
      data: Array<{
        memberId: string;
        seasonYear: number;
        membershipTypeId: string;
      }>;
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
  membershipTypeAgeTier?: {
    createMany(args: {
      data: Array<{
        membershipTypeId: string;
        ageTier: AgeTier;
      }>;
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
}

export function serializeMembershipType(type: MembershipTypeWithAssignmentCount) {
  return {
    id: type.id,
    key: type.key,
    name: type.name,
    description: type.description,
    publicDescription: type.publicDescription,
    publiclyListed: type.publiclyListed,
    isActive: type.isActive,
    isBuiltIn: type.isBuiltIn,
    bookingBehavior: type.bookingBehavior,
    subscriptionBehavior: type.subscriptionBehavior,
    ageGroupsApply: type.ageGroupsApply ?? true,
    sortOrder: type.sortOrder,
    createdAt: type.createdAt.toISOString(),
    updatedAt: type.updatedAt.toISOString(),
    assignmentCount: type._count?.assignments ?? 0,
    allowedAgeTiers: (type.allowedAgeTiers ?? []).map((item) => item.ageTier),
  };
}

export function normalizeMembershipTypeText(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

// test seam
export function normalizeMembershipTypeKey(name: string): string {
  const normalized = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MEMBERSHIP_TYPE_KEY_MAX_LENGTH);
  return normalized || "CUSTOM";
}

export async function buildUniqueMembershipTypeKey(
  db: {
    membershipType: {
      findUnique(args: {
        where: { key: string };
        select: { id: true };
      }): Promise<{ id: string } | null>;
    };
  },
  name: string,
): Promise<string> {
  const base = normalizeMembershipTypeKey(name);
  let candidate = base;
  let suffix = 2;

  while (
    await db.membershipType.findUnique({
      where: { key: candidate },
      select: { id: true },
    })
  ) {
    const suffixText = `_${suffix}`;
    candidate = `${base.slice(
      0,
      MEMBERSHIP_TYPE_KEY_MAX_LENGTH - suffixText.length,
    )}${suffixText}`;
    suffix += 1;
  }

  return candidate;
}

export function defaultMembershipTypeKeyForRole(
  role: Role | string,
): BuiltInMembershipTypeKey {
  if (role === "ASSOCIATE" || role === "RESERVE") {
    return "ASSOCIATE";
  }
  if (role === "LIFE") {
    return "LIFE";
  }
  if (role === "SCHOOL") {
    return "SCHOOL";
  }
  if (role === "NON_MEMBER") {
    return "NON_MEMBER";
  }
  return "FULL";
}

// test seam
export function canonicalMembershipTypeKey(
  key: string | null | undefined,
): string | null {
  if (!key) return null;
  return LEGACY_MEMBERSHIP_TYPE_KEY_ALIAS_MAP[key] ?? key;
}

// test seam
export async function ensureBuiltInMembershipTypes(
  db: MembershipTypeSeedClient,
): Promise<void> {
  for (const type of BUILT_IN_MEMBERSHIP_TYPES) {
    await db.membershipType.upsert({
      where: { key: type.key },
      update: {},
      create: {
        key: type.key,
        name: type.name,
        description: type.description,
        isActive: true,
        isBuiltIn: true,
        bookingBehavior: type.bookingBehavior,
        subscriptionBehavior: type.subscriptionBehavior,
        sortOrder: type.sortOrder,
      },
    });
  }

  if (!db.membershipTypeAgeTier) return;

  const seededTypes = await db.membershipType.findMany({
    where: { key: { in: [...BUILT_IN_MEMBERSHIP_TYPE_KEYS] } },
    select: { id: true, key: true },
  });
  const allowedAgeTierRows = seededTypes.flatMap((type) =>
    BUILT_IN_MEMBERSHIP_TYPE_ALLOWED_AGE_TIERS[
      type.key as BuiltInMembershipTypeKey
    ].map((ageTier) => ({
      membershipTypeId: type.id,
      ageTier,
    })),
  );

  if (allowedAgeTierRows.length > 0) {
    await db.membershipTypeAgeTier.createMany({
      data: allowedAgeTierRows,
      skipDuplicates: true,
    });
  }
}

export async function backfillCurrentSeasonMembershipAssignments(
  db: MembershipTypeSeedClient,
  seasonYear: number = getSeasonYear(),
): Promise<{ createdCount: number; seasonYear: number }> {
  await ensureBuiltInMembershipTypes(db);

  const [types, members] = await Promise.all([
    db.membershipType.findMany({
      where: { key: { in: [...BUILT_IN_MEMBERSHIP_TYPE_KEYS] } },
      select: { id: true, key: true },
    }),
    db.member.findMany({ select: { id: true, role: true } }),
  ]);

  const typeIdByKey = new Map(types.map((type) => [type.key, type.id]));
  const data = members
    .map((member) => {
      const key = defaultMembershipTypeKeyForRole(member.role);
      const membershipTypeId = typeIdByKey.get(key);
      return membershipTypeId
        ? {
            memberId: member.id,
            seasonYear,
            membershipTypeId,
          }
        : null;
    })
    .filter(
      (
        assignment,
      ): assignment is {
        memberId: string;
        seasonYear: number;
        membershipTypeId: string;
      } => assignment !== null,
    );

  if (data.length === 0) {
    return { createdCount: 0, seasonYear };
  }

  const result = await db.seasonalMembershipAssignment.createMany({
    data,
    skipDuplicates: true,
  });

  return { createdCount: result.count, seasonYear };
}

export function membershipTypeOrderBy(): Prisma.MembershipTypeOrderByWithRelationInput[] {
  return [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }];
}
