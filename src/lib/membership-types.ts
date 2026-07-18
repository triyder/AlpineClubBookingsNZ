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

export const MEMBERSHIP_TYPE_AGE_TIERS = [
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

export function validateMembershipTypeRuleConfiguration(params: {
  allowedAgeTiers: readonly AgeTier[];
}): string | null {
  if (params.allowedAgeTiers.length === 0) {
    return "Select at least one allowed age tier.";
  }
  return null;
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
