import type {
  AgeTier,
  MembershipTypeBookingBehavior,
  MembershipTypeSubscriptionBehavior,
  Role,
} from "@prisma/client";
import { BUILT_IN_MEMBERSHIP_TYPES, defaultMembershipTypeKeyForRole } from "@/lib/membership-types";
import { requiresPaidSubscriptionForBooking } from "@/lib/member-subscription-eligibility";
import {
  calculateBookingPrice,
  type GroupDiscountConfig,
  type PriceBreakdown,
  type RateSource,
  type SeasonRateData,
  type UnratedGuestInput,
} from "@/lib/pricing";

const NON_MEMBER_MEMBERSHIP_TYPE_KEY = "NON_MEMBER";
const BUILT_IN_MEMBERSHIP_TYPE_KEYS = BUILT_IN_MEMBERSHIP_TYPES.map(
  (type) => type.key,
);
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

export type GuestRateResolution = {
  rateMembershipTypeId: string;
  rateSource: RateSource;
};

/**
 * Resolve every guest's rate membership type + rateSource (#1930, E4, D3).
 * This REPLACES the old `applyMembershipTypeRatePolicyToGuests` boolean flip:
 *   - a true non-member  -> the built-in NON_MEMBER type (NON_MEMBER_DEFAULT),
 *   - a MEMBER_RATE member -> their own type (OWN_TYPE),
 *   - a member whose type forces the non-member rate (NON_MEMBER_RATE) or is
 *     otherwise non-MEMBER_RATE -> the NON_MEMBER type (TYPE_POLICY_FORCED).
 * The result is persisted as the BookingGuest.rateMembershipTypeId snapshot and
 * fed straight into calculateBookingPrice. Extends (does not fork) the shared
 * `resolveMembershipTypePoliciesForMembers` effective-type helper.
 */
export async function resolveGuestRateMembershipTypes<
  Guest extends { isMember: boolean; memberId?: string | null },
>(
  db: unknown,
  params: {
    seasonYear: number;
    guests: ReadonlyArray<Guest>;
  },
): Promise<Array<Guest & GuestRateResolution>> {
  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: params.guests.map((guest) => guest.memberId),
    seasonYear: params.seasonYear,
  });

  // Built-in type ids: the NON_MEMBER default target, plus a key->id map that
  // backfills any built-in fallback policy whose membershipType.id is null.
  const typeIdByKey = new Map<string, string>();
  if (isMembershipTypePolicyDb(db)) {
    const types = (await db.membershipType.findMany({
      where: { key: { in: [...BUILT_IN_MEMBERSHIP_TYPE_KEYS] } },
      select: { id: true, key: true },
    })) as Array<{ id: string; key: string }>;
    for (const type of types) {
      typeIdByKey.set(type.key, type.id);
    }
  }

  const requireTypeId = (id: string | null | undefined, label: string): string => {
    if (!id) {
      throw new Error(
        `Cannot price booking: membership type "${label}" is not present in the database.`,
      );
    }
    return id;
  };
  const nonMemberTypeId = () =>
    requireTypeId(
      typeIdByKey.get(NON_MEMBER_MEMBERSHIP_TYPE_KEY),
      NON_MEMBER_MEMBERSHIP_TYPE_KEY,
    );
  // Member-rate fallback for a member whose specific type cannot be resolved
  // (no memberId — e.g. an orphaned guest whose member row was SetNull'd — or
  // no policy row). Mirrors both the old engine (any isMember guest priced at
  // the member rate) and the Xero NULL-snapshot fallback (isMember -> FULL), so
  // day-one resolution stays byte-identical.
  const fullTypeId = () => requireTypeId(typeIdByKey.get("FULL"), "FULL");

  return params.guests.map((guest) => {
    if (!guest.isMember) {
      // True non-member: the only class the group discount may substitute.
      return {
        ...guest,
        rateMembershipTypeId: nonMemberTypeId(),
        rateSource: "NON_MEMBER_DEFAULT" as const,
      };
    }
    const policy = guest.memberId ? policies.get(guest.memberId) : undefined;
    if (!policy) {
      // A member with no resolvable type prices at the member (FULL) rate.
      return {
        ...guest,
        rateMembershipTypeId: fullTypeId(),
        rateSource: "OWN_TYPE" as const,
      };
    }
    if (policy.bookingBehavior === "MEMBER_RATE") {
      const ownId =
        policy.membershipType.id ?? typeIdByKey.get(policy.membershipType.key);
      return {
        ...guest,
        rateMembershipTypeId: requireTypeId(ownId, policy.membershipType.key),
        rateSource: "OWN_TYPE" as const,
      };
    }
    // NON_MEMBER_RATE, or BLOCK_BOOKING (blocked before pricing): both price
    // from the built-in NON_MEMBER type's rows.
    return {
      ...guest,
      rateMembershipTypeId: nonMemberTypeId(),
      rateSource: "TYPE_POLICY_FORCED" as const,
    };
  });
}

/**
 * Read-time fallback for the group-discount substitution target (#1930, E4).
 * A GroupDiscountSetting row created AFTER the re-key migration (the admin
 * route's old upsert-create, or any hand-inserted row) carries a NULL
 * rateMembershipTypeId; without this fallback an enabled discount would be
 * silently inert (the engine only substitutes when a target id is present),
 * where main's boolean flip always discounted. Resolve NULL to the built-in
 * FULL type — the same target the migration seeds — so the discount always
 * works. No-op (no query) when the discount is disabled or already targeted.
 */
export async function resolveGroupDiscountRateType(
  db: unknown,
  groupDiscount: GroupDiscountConfig | undefined,
): Promise<GroupDiscountConfig | undefined> {
  if (!groupDiscount?.enabled || groupDiscount.rateMembershipTypeId) {
    return groupDiscount;
  }
  if (!isMembershipTypePolicyDb(db)) {
    return groupDiscount;
  }
  const [fullType] = (await db.membershipType.findMany({
    where: { key: { in: ["FULL"] } },
    select: { id: true },
  })) as Array<{ id: string }>;
  return fullType
    ? { ...groupDiscount, rateMembershipTypeId: fullType.id }
    : groupDiscount;
}

export async function priceBookingGuestsWithMembershipTypePolicy(
  db: unknown,
  input: {
    ownerMemberId?: string | null;
    checkIn: Date;
    checkOut: Date;
    guests: UnratedGuestInput[];
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
  const [ratedGuests, groupDiscount] = await Promise.all([
    resolveGuestRateMembershipTypes(db, {
      seasonYear,
      guests: input.guests,
    }),
    resolveGroupDiscountRateType(db, input.groupDiscount),
  ]);
  return calculateBookingPrice(
    input.checkIn,
    input.checkOut,
    ratedGuests,
    input.seasons,
    groupDiscount,
  );
}

// Structural read seam so the NOT_REQUIRED-row dominance check works with
// PrismaClient, a transaction client, and test doubles alike.
type MemberSubscriptionStatusReadDb = {
  memberSubscription: {
    findFirst(args: {
      where: { memberId: string; seasonYear: number; status: "NOT_REQUIRED" };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
};

function canReadMemberSubscriptionStatus(
  db: unknown,
): db is MemberSubscriptionStatusReadDb {
  const candidate = db as Partial<MemberSubscriptionStatusReadDb> | null | undefined;
  return typeof candidate?.memberSubscription?.findFirst === "function";
}

async function hasNotRequiredSubscriptionRow(
  db: unknown,
  params: { memberId: string; seasonYear: number },
): Promise<boolean> {
  if (!canReadMemberSubscriptionStatus(db)) {
    return false;
  }
  const row = await db.memberSubscription.findFirst({
    where: {
      memberId: params.memberId,
      seasonYear: params.seasonYear,
      status: "NOT_REQUIRED",
    },
    select: { id: true },
  });
  return row !== null;
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
  // #2149: role-based subscription exemption dropped. Membership type is the sole
  // authority — a bare ADMIN/LODGE account resolves (via the role→default-type
  // fallback) to its own NOT_REQUIRED built-in type and is caught above, while a
  // fee-paying human who holds the admin permission carries a REQUIRED membership
  // type and now correctly owes a subscription.
  // BASED_ON_AGE_TIER (issue #2041): the type defers its subscription-required
  // answer to the per-age-tier flag (decision Q2 — the same
  // AgeTierSetting.subscriptionRequiredForBooking that gates invoice minting).
  // A NOT_REQUIRED MemberSubscription row for the season is authoritative and
  // dominates: the annual-fee sweep writes it for a tier-exempt member (season-
  // start age), so it keeps the booking gate consistent with billing even if
  // the stored ageTier is later promoted mid-season (decision Q4). This keeps
  // one coherent meaning of "not required" (DOMAIN_INVARIANTS paid-up
  // one-meaning). Scoped to BASED_ON_AGE_TIER so REQUIRED/NOT_REQUIRED types are
  // byte-unchanged (no extra query on their booking path).
  if (
    policy?.subscriptionBehavior === "BASED_ON_AGE_TIER" &&
    (await hasNotRequiredSubscriptionRow(db, {
      memberId: params.memberId,
      seasonYear: params.seasonYear,
    }))
  ) {
    return false;
  }
  return requiresPaidSubscriptionForBooking(params.ageTier);
}
