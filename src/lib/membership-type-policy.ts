import type {
  AgeTier,
  MembershipTypeBookingBehavior,
  MembershipTypeSubscriptionBehavior,
  Role,
} from "@prisma/client";
import { BUILT_IN_MEMBERSHIP_TYPES, defaultMembershipTypeKeyForRole } from "@/lib/membership-types";
import { roleNeverRequiresSubscription } from "@/lib/member-subscription-defaults";
import { requiresPaidSubscriptionForBooking } from "@/lib/member-subscription-eligibility";
import {
  calculateBookingPrice,
  type GroupDiscountConfig,
  type GuestInput,
  type PriceBreakdown,
  type SeasonRateData,
} from "@/lib/pricing";
import { getSeasonYear } from "@/lib/utils";

const MEMBERSHIP_TYPE_BLOCKS_BOOKING_CODE =
  "MEMBERSHIP_TYPE_BLOCKS_BOOKING";

type PolicyDbDelegate<Row> = {
  findMany(args: unknown): Promise<Row[]>;
};

type MembershipTypePolicyDb = {
  member: PolicyDbDelegate<MembershipTypePolicyMember>;
  seasonalMembershipAssignment: PolicyDbDelegate<SeasonalMembershipAssignmentPolicyRow>;
  membershipType: PolicyDbDelegate<MembershipTypePolicyType>;
};

type MembershipTypePolicySource =
  | "assignment"
  | "role_default"
  | "built_in_default";

type MembershipTypePolicyType = {
  id: string | null;
  key: string;
  name: string;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: MembershipTypeBookingBehavior;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior;
};

type MembershipTypePolicyMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
  ageTier: AgeTier;
};

type SeasonalMembershipAssignmentPolicyRow = {
  memberId: string;
  seasonYear: number;
  membershipType: MembershipTypePolicyType;
};

export type ResolvedMembershipTypePolicy = {
  memberId: string;
  memberName: string;
  memberRole: Role;
  memberAgeTier: AgeTier;
  seasonYear: number;
  source: MembershipTypePolicySource;
  membershipType: MembershipTypePolicyType;
  bookingBehavior: MembershipTypeBookingBehavior;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior;
};

export type MembershipTypeBookingPolicyBlock = {
  scope: "BOOKING_OWNER" | "MEMBER_GUEST";
  memberId: string;
  name: string;
  seasonYear: number;
  membershipTypeKey: string;
  membershipTypeName: string;
  bookingBehavior: MembershipTypeBookingBehavior;
};

export class MembershipTypeBookingPolicyError extends Error {
  public readonly code = MEMBERSHIP_TYPE_BLOCKS_BOOKING_CODE;
  public readonly status = 403;

  constructor(public readonly blockedMembers: MembershipTypeBookingPolicyBlock[]) {
    super(buildMembershipTypeBookingPolicyMessage(blockedMembers));
    this.name = "MembershipTypeBookingPolicyError";
  }
}

export function getMembershipTypeBookingPolicyErrorBody(
  error: MembershipTypeBookingPolicyError,
) {
  return {
    error: error.message,
    code: error.code,
    blockedMembers: error.blockedMembers.map((block) => ({
      scope: block.scope,
      memberId: block.memberId,
      name: block.name,
      seasonYear: block.seasonYear,
      membershipTypeKey: block.membershipTypeKey,
      membershipTypeName: block.membershipTypeName,
      bookingBehavior: block.bookingBehavior,
    })),
  };
}

function isMembershipTypePolicyDb(db: unknown): db is MembershipTypePolicyDb {
  const candidate = db as Partial<MembershipTypePolicyDb> | null | undefined;
  return Boolean(
    candidate?.member?.findMany &&
      candidate.seasonalMembershipAssignment?.findMany &&
      candidate.membershipType?.findMany,
  );
}

function formatSeasonDisplay(seasonYear: number) {
  return `${seasonYear}/${seasonYear + 1}`;
}

function memberDisplayName(member: Pick<MembershipTypePolicyMember, "firstName" | "lastName" | "email">) {
  return `${member.firstName} ${member.lastName}`.trim() || member.email;
}

function toPolicyType(
  type: Omit<MembershipTypePolicyType, "id"> & { id?: string | null },
): MembershipTypePolicyType {
  return {
    id: type.id ?? null,
    key: type.key,
    name: type.name,
    isActive: type.isActive,
    isBuiltIn: type.isBuiltIn,
    bookingBehavior: type.bookingBehavior,
    subscriptionBehavior: type.subscriptionBehavior,
  };
}

function builtInPolicyTypeForKey(key: string): MembershipTypePolicyType | null {
  const builtIn = BUILT_IN_MEMBERSHIP_TYPES.find((type) => type.key === key);
  if (!builtIn) {
    return null;
  }
  return toPolicyType({
    id: null,
    key: builtIn.key,
    name: builtIn.name,
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: builtIn.bookingBehavior,
    subscriptionBehavior: builtIn.subscriptionBehavior,
  });
}

function buildPolicy(
  member: MembershipTypePolicyMember,
  seasonYear: number,
  membershipType: MembershipTypePolicyType,
  source: MembershipTypePolicySource,
): ResolvedMembershipTypePolicy {
  return {
    memberId: member.id,
    memberName: memberDisplayName(member),
    memberRole: member.role,
    memberAgeTier: member.ageTier,
    seasonYear,
    source,
    membershipType,
    bookingBehavior: membershipType.bookingBehavior,
    subscriptionBehavior: membershipType.subscriptionBehavior,
  };
}

export async function resolveMembershipTypePoliciesForMembers(
  db: unknown,
  params: {
    memberIds: ReadonlyArray<string | null | undefined>;
    seasonYear: number;
  },
): Promise<Map<string, ResolvedMembershipTypePolicy>> {
  if (!isMembershipTypePolicyDb(db)) {
    return new Map();
  }

  const memberIds = [
    ...new Set(
      params.memberIds
        .map((memberId) => memberId?.trim())
        .filter((memberId): memberId is string => Boolean(memberId)),
    ),
  ];
  if (memberIds.length === 0) {
    return new Map();
  }

  const [members, assignments] = await Promise.all([
    db.member.findMany({
      where: { id: { in: memberIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        ageTier: true,
      },
    }),
    db.seasonalMembershipAssignment.findMany({
      where: {
        memberId: { in: memberIds },
        seasonYear: params.seasonYear,
      },
      include: {
        membershipType: {
          select: {
            id: true,
            key: true,
            name: true,
            isActive: true,
            isBuiltIn: true,
            bookingBehavior: true,
            subscriptionBehavior: true,
          },
        },
      },
    }),
  ]);

  const assignmentByMemberId = new Map(
    assignments.map((assignment) => [assignment.memberId, assignment]),
  );
  const fallbackKeys = [
    ...new Set(
      members
        .filter((member) => !assignmentByMemberId.has(member.id))
        .map((member) => defaultMembershipTypeKeyForRole(member.role)),
    ),
  ];
  const fallbackTypes = fallbackKeys.length > 0
    ? await db.membershipType.findMany({
        where: { key: { in: fallbackKeys } },
        select: {
          id: true,
          key: true,
          name: true,
          isActive: true,
          isBuiltIn: true,
          bookingBehavior: true,
          subscriptionBehavior: true,
        },
      })
    : [];
  const fallbackTypeByKey = new Map(
    fallbackTypes.map((type) => [type.key, toPolicyType(type)]),
  );

  const policies = new Map<string, ResolvedMembershipTypePolicy>();
  for (const member of members) {
    const assignment = assignmentByMemberId.get(member.id);
    if (assignment) {
      policies.set(
        member.id,
        buildPolicy(
          member,
          params.seasonYear,
          toPolicyType(assignment.membershipType),
          "assignment",
        ),
      );
      continue;
    }

    const defaultKey = defaultMembershipTypeKeyForRole(member.role);
    const fallbackType =
      fallbackTypeByKey.get(defaultKey) ?? builtInPolicyTypeForKey(defaultKey);
    if (!fallbackType) {
      continue;
    }

    policies.set(
      member.id,
      buildPolicy(
        member,
        params.seasonYear,
        fallbackType,
        fallbackTypeByKey.has(defaultKey) ? "role_default" : "built_in_default",
      ),
    );
  }

  return policies;
}

export async function resolveMembershipTypePolicyForMember(
  db: unknown,
  params: {
    memberId: string;
    seasonYear: number;
  },
): Promise<ResolvedMembershipTypePolicy | null> {
  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: [params.memberId],
    seasonYear: params.seasonYear,
  });
  return policies.get(params.memberId) ?? null;
}

function buildMembershipTypeBookingPolicyMessage(
  blocks: MembershipTypeBookingPolicyBlock[],
) {
  if (blocks.length === 0) {
    return "Membership type booking policy blocks this booking.";
  }

  const ownerBlock = blocks.find((block) => block.scope === "BOOKING_OWNER");
  if (ownerBlock && blocks.length === 1) {
    return `Your ${formatSeasonDisplay(ownerBlock.seasonYear)} membership type (${ownerBlock.membershipTypeName}) does not allow lodge bookings.`;
  }

  const guestBlocks = blocks.filter((block) => block.scope === "MEMBER_GUEST");
  if (guestBlocks.length === blocks.length) {
    return `The following member guests cannot be booked for the ${formatSeasonDisplay(guestBlocks[0].seasonYear)} season: ${guestBlocks.map((block) => block.name).join(", ")}.`;
  }

  return `One or more members cannot be booked for the ${formatSeasonDisplay(blocks[0].seasonYear)} season under their membership type policy.`;
}

export async function getMembershipTypeBookingPolicyBlocks(
  db: unknown,
  params: {
    seasonYear: number;
    ownerMemberId?: string | null;
    guests?: ReadonlyArray<{ isMember: boolean; memberId?: string | null }>;
  },
): Promise<MembershipTypeBookingPolicyBlock[]> {
  const guestMemberIds =
    params.guests
      ?.filter((guest) => guest.isMember && guest.memberId)
      .map((guest) => guest.memberId as string) ?? [];
  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: [params.ownerMemberId, ...guestMemberIds],
    seasonYear: params.seasonYear,
  });
  const blocks: MembershipTypeBookingPolicyBlock[] = [];

  const ownerPolicy = params.ownerMemberId
    ? policies.get(params.ownerMemberId)
    : null;
  if (ownerPolicy?.bookingBehavior === "BLOCK_BOOKING") {
    blocks.push({
      scope: "BOOKING_OWNER",
      memberId: ownerPolicy.memberId,
      name: ownerPolicy.memberName,
      seasonYear: ownerPolicy.seasonYear,
      membershipTypeKey: ownerPolicy.membershipType.key,
      membershipTypeName: ownerPolicy.membershipType.name,
      bookingBehavior: ownerPolicy.bookingBehavior,
    });
  }

  const seenGuestBlocks = new Set<string>();
  for (const memberId of guestMemberIds) {
    if (seenGuestBlocks.has(memberId)) {
      continue;
    }
    seenGuestBlocks.add(memberId);
    const policy = policies.get(memberId);
    if (policy?.bookingBehavior !== "BLOCK_BOOKING") {
      continue;
    }
    blocks.push({
      scope: "MEMBER_GUEST",
      memberId: policy.memberId,
      name: policy.memberName,
      seasonYear: policy.seasonYear,
      membershipTypeKey: policy.membershipType.key,
      membershipTypeName: policy.membershipType.name,
      bookingBehavior: policy.bookingBehavior,
    });
  }

  return blocks;
}

export async function assertMembershipTypeBookingAllowed(
  db: unknown,
  params: Parameters<typeof getMembershipTypeBookingPolicyBlocks>[1],
): Promise<void> {
  const blocks = await getMembershipTypeBookingPolicyBlocks(db, params);
  if (blocks.length > 0) {
    throw new MembershipTypeBookingPolicyError(blocks);
  }
}

export async function applyMembershipTypeRatePolicyToGuests<
  Guest extends { isMember: boolean; memberId?: string | null; forceNonMemberRate?: boolean },
>(
  db: unknown,
  params: {
    seasonYear: number;
    guests: ReadonlyArray<Guest>;
  },
): Promise<Guest[]> {
  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: params.guests.map((guest) => guest.memberId),
    seasonYear: params.seasonYear,
  });

  return params.guests.map((guest) => {
    if (!guest.isMember || !guest.memberId) {
      return { ...guest };
    }
    const policy = policies.get(guest.memberId);
    if (policy?.bookingBehavior !== "NON_MEMBER_RATE") {
      return { ...guest };
    }
    return {
      ...guest,
      forceNonMemberRate: true,
    };
  });
}

function restoreOriginalGuestIdentity(
  price: PriceBreakdown,
  guests: ReadonlyArray<{ isMember: boolean }>,
): PriceBreakdown {
  return {
    ...price,
    guests: price.guests.map((guest, index) => ({
      ...guest,
      isMember: guests[index]?.isMember ?? guest.isMember,
    })),
  };
}

export async function priceBookingGuestsWithMembershipTypePolicy(
  db: unknown,
  input: {
    ownerMemberId?: string | null;
    checkIn: Date;
    checkOut: Date;
    guests: GuestInput[];
    seasons: SeasonRateData[];
    groupDiscount?: GroupDiscountConfig;
    seasonYear?: number;
  },
): Promise<PriceBreakdown> {
  const seasonYear = input.seasonYear ?? getSeasonYear(input.checkIn);
  await assertMembershipTypeBookingAllowed(db, {
    ownerMemberId: input.ownerMemberId,
    guests: input.guests,
    seasonYear,
  });
  const pricedGuests = await applyMembershipTypeRatePolicyToGuests(db, {
    seasonYear,
    guests: input.guests,
  });
  return restoreOriginalGuestIdentity(
    calculateBookingPrice(
      input.checkIn,
      input.checkOut,
      pricedGuests,
      input.seasons,
      input.groupDiscount,
    ),
    input.guests,
  );
}

export async function requiresPaidSubscriptionForMemberForBooking(
  db: unknown,
  params: {
    memberId: string;
    seasonYear: number;
    ageTier: AgeTier | null | undefined;
  },
): Promise<boolean> {
  const policy = await resolveMembershipTypePolicyForMember(db, {
    memberId: params.memberId,
    seasonYear: params.seasonYear,
  });
  if (policy?.subscriptionBehavior === "NOT_REQUIRED") {
    return false;
  }
  if (policy && roleNeverRequiresSubscription(policy.memberRole)) {
    return false;
  }
  return requiresPaidSubscriptionForBooking(params.ageTier);
}
