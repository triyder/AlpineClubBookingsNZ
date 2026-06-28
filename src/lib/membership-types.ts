import type {
  MembershipTypeBookingBehavior,
  MembershipTypeSubscriptionBehavior,
  Prisma,
  Role,
} from "@prisma/client";
import { getSeasonYear } from "@/lib/utils";

export const MEMBERSHIP_TYPE_KEY_MAX_LENGTH = 80;

export const MEMBERSHIP_TYPE_BOOKING_BEHAVIORS = [
  "MEMBER_RATE",
  "NON_MEMBER_RATE",
  "BLOCK_BOOKING",
] as const satisfies readonly MembershipTypeBookingBehavior[];

export const MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS = [
  "REQUIRED",
  "NOT_REQUIRED",
] as const satisfies readonly MembershipTypeSubscriptionBehavior[];

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
      "Associate membership starts with non-member booking-rate policy until enforcement is enabled.",
    bookingBehavior: "NON_MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 1,
  },
  {
    key: "RESERVE",
    name: "Reserve",
    description:
      "Reserve membership starts with booking blocked until enforcement is enabled.",
    bookingBehavior: "BLOCK_BOOKING",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 2,
  },
  {
    key: "LIFE",
    name: "Life",
    description:
      "Life membership starts with member booking-rate policy and no annual subscription requirement.",
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "NOT_REQUIRED",
    sortOrder: 3,
  },
] as const satisfies ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  bookingBehavior: MembershipTypeBookingBehavior;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior;
  sortOrder: number;
}>;

export const BUILT_IN_MEMBERSHIP_TYPE_KEYS = BUILT_IN_MEMBERSHIP_TYPES.map(
  (type) => type.key,
);

export type BuiltInMembershipTypeKey =
  (typeof BUILT_IN_MEMBERSHIP_TYPES)[number]["key"];

type MembershipTypeWithAssignmentCount = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: MembershipTypeBookingBehavior;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  _count?: {
    assignments: number;
  };
};

export type SerializedMembershipType = ReturnType<
  typeof serializeMembershipType
>;

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
}

export function serializeMembershipType(type: MembershipTypeWithAssignmentCount) {
  return {
    id: type.id,
    key: type.key,
    name: type.name,
    description: type.description,
    isActive: type.isActive,
    isBuiltIn: type.isBuiltIn,
    bookingBehavior: type.bookingBehavior,
    subscriptionBehavior: type.subscriptionBehavior,
    sortOrder: type.sortOrder,
    createdAt: type.createdAt.toISOString(),
    updatedAt: type.updatedAt.toISOString(),
    assignmentCount: type._count?.assignments ?? 0,
  };
}

export function normalizeMembershipTypeText(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

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
  if (role === "ASSOCIATE") {
    return "ASSOCIATE";
  }
  if (role === "LIFE") {
    return "LIFE";
  }
  return "FULL";
}

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
