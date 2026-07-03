import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import {
  MembershipTypeBookingPolicyError,
  getMembershipTypeBookingPolicyErrorBody,
  priceBookingGuestsWithMembershipTypePolicy,
  requiresPaidSubscriptionForMemberForBooking,
  resolveMembershipTypePoliciesForMembers,
} from "@/lib/membership-type-policy";

vi.mock("@/lib/member-subscription-eligibility", () => ({
  requiresPaidSubscriptionForBooking: vi.fn(async () => true),
}));

function readRepoFile(path: string) {
  return readFileSync(`${process.cwd()}/${path}`, "utf8");
}

type PolicyMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: "MEMBER" | "LIFE" | "ADMIN";
  ageTier: "ADULT";
};

type PolicyType = {
  id: string;
  key: string;
  name: string;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
  subscriptionBehavior: "REQUIRED" | "NOT_REQUIRED";
};

const fullType: PolicyType = {
  id: "type-full",
  key: "FULL",
  name: "Full",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
};

const associateType: PolicyType = {
  id: "type-associate",
  key: "ASSOCIATE",
  name: "Associate",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "NON_MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
};

const renamedAssociateBlockType: PolicyType = {
  id: "type-associate",
  key: "ASSOCIATE",
  name: "Reserve",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "BLOCK_BOOKING",
  subscriptionBehavior: "REQUIRED",
};

const lifeType: PolicyType = {
  id: "type-life",
  key: "LIFE",
  name: "Life",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "NOT_REQUIRED",
};

function makeMember(overrides: Partial<PolicyMember> = {}): PolicyMember {
  return {
    id: "member-1",
    firstName: "Alex",
    lastName: "Member",
    email: "alex@example.test",
    role: "MEMBER",
    ageTier: "ADULT",
    ...overrides,
  };
}

function makePolicyDb(options: {
  members: PolicyMember[];
  assignments?: Array<{ memberId: string; seasonYear: number; membershipType: PolicyType }>;
  membershipTypes?: PolicyType[];
}) {
  return {
    member: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        options.members.filter((member) => args.where.id.in.includes(member.id)),
      ),
    },
    seasonalMembershipAssignment: {
      findMany: vi.fn(
        async (args: { where: { memberId: { in: string[] }; seasonYear: number } }) =>
          (options.assignments ?? []).filter(
            (assignment) =>
              args.where.memberId.in.includes(assignment.memberId) &&
              assignment.seasonYear === args.where.seasonYear,
          ),
      ),
    },
    membershipType: {
      findMany: vi.fn(async (args: { where: { key: { in: string[] } } }) =>
        (options.membershipTypes ?? []).filter((type) =>
          args.where.key.in.includes(type.key),
        ),
      ),
    },
  };
}

const seasonRates = [
  {
    seasonId: "season-2026",
    startDate: new Date("2026-04-01T00:00:00.000Z"),
    endDate: new Date("2026-10-31T00:00:00.000Z"),
    rates: [
      { ageTier: "ADULT" as const, isMember: true, pricePerNightCents: 1000 },
      { ageTier: "ADULT" as const, isMember: false, pricePerNightCents: 2400 },
    ],
  },
];

describe("membership type booking and subscription policy", () => {
  it("resolves explicit seasonal assignments before role defaults", async () => {
    const db = makePolicyDb({
      members: [makeMember()],
      assignments: [
        { memberId: "member-1", seasonYear: 2026, membershipType: associateType },
      ],
      membershipTypes: [fullType],
    });

    const policies = await resolveMembershipTypePoliciesForMembers(db, {
      memberIds: ["member-1"],
      seasonYear: 2026,
    });

    expect(policies.get("member-1")).toMatchObject({
      source: "assignment",
      bookingBehavior: "NON_MEMBER_RATE",
      subscriptionBehavior: "REQUIRED",
      membershipType: { key: "ASSOCIATE" },
    });
  });

  it("falls back to built-in role defaults when the type row is missing", async () => {
    const db = makePolicyDb({
      members: [makeMember({ id: "life-1", role: "LIFE" })],
      membershipTypes: [],
    });

    const policies = await resolveMembershipTypePoliciesForMembers(db, {
      memberIds: ["life-1"],
      seasonYear: 2026,
    });

    expect(policies.get("life-1")).toMatchObject({
      source: "built_in_default",
      subscriptionBehavior: "NOT_REQUIRED",
      membershipType: { key: "LIFE" },
    });
  });

  it("throws a structured block error for booking owners and member guests", async () => {
    const db = makePolicyDb({
      members: [
        makeMember({ id: "owner-1", firstName: "Blocked", lastName: "Owner" }),
        makeMember({ id: "guest-1", firstName: "Blocked", lastName: "Guest" }),
      ],
      assignments: [
        {
          memberId: "owner-1",
          seasonYear: 2026,
          membershipType: renamedAssociateBlockType,
        },
        {
          memberId: "guest-1",
          seasonYear: 2026,
          membershipType: renamedAssociateBlockType,
        },
      ],
    });

    await expect(
      priceBookingGuestsWithMembershipTypePolicy(db, {
        ownerMemberId: "owner-1",
        checkIn: new Date("2026-05-01T00:00:00.000Z"),
        checkOut: new Date("2026-05-02T00:00:00.000Z"),
        guests: [{ ageTier: "ADULT", isMember: true, memberId: "guest-1" }],
        seasons: seasonRates,
      }),
    ).rejects.toMatchObject({
      code: "MEMBERSHIP_TYPE_BLOCKS_BOOKING",
      status: 403,
    });

    try {
      await priceBookingGuestsWithMembershipTypePolicy(db, {
        ownerMemberId: "owner-1",
        checkIn: new Date("2026-05-01T00:00:00.000Z"),
        checkOut: new Date("2026-05-02T00:00:00.000Z"),
        guests: [{ ageTier: "ADULT", isMember: true, memberId: "guest-1" }],
        seasons: seasonRates,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MembershipTypeBookingPolicyError);
      const body = getMembershipTypeBookingPolicyErrorBody(
        error as MembershipTypeBookingPolicyError,
      );
      expect(body).toMatchObject({
        code: "MEMBERSHIP_TYPE_BLOCKS_BOOKING",
        blockedMembers: [
          { scope: "BOOKING_OWNER", memberId: "owner-1", bookingBehavior: "BLOCK_BOOKING" },
          { scope: "MEMBER_GUEST", memberId: "guest-1", bookingBehavior: "BLOCK_BOOKING" },
        ],
      });
    }
  });

  it("prices NON_MEMBER_RATE members at non-member rates while preserving identity", async () => {
    const db = makePolicyDb({
      members: [makeMember()],
      assignments: [
        { memberId: "member-1", seasonYear: 2026, membershipType: associateType },
      ],
    });

    const price = await priceBookingGuestsWithMembershipTypePolicy(db, {
      ownerMemberId: "member-1",
      checkIn: new Date("2026-05-01T00:00:00.000Z"),
      checkOut: new Date("2026-05-02T00:00:00.000Z"),
      guests: [{ ageTier: "ADULT", isMember: true, memberId: "member-1" }],
      seasons: seasonRates,
      groupDiscount: { enabled: true, minGroupSize: 1, summerOnly: false },
    });

    expect(price.totalPriceCents).toBe(2400);
    expect(price.guests[0]).toMatchObject({
      isMember: true,
      perNightCents: [2400],
    });
  });

  it("exempts NOT_REQUIRED membership types from booking subscription lockout", async () => {
    const db = makePolicyDb({
      members: [makeMember()],
      assignments: [
        { memberId: "member-1", seasonYear: 2026, membershipType: lifeType },
      ],
    });

    await expect(
      requiresPaidSubscriptionForMemberForBooking(db, {
        memberId: "member-1",
        seasonYear: 2026,
        ageTier: "ADULT",
      }),
    ).resolves.toBe(false);
  });
});

describe("membership type booking policy route integration", () => {
  it("preserves policy block errors through generic booking pricing failures", () => {
    const sources = [
      "src/lib/booking-modify-plan.ts",
      "src/lib/booking-date-modification-service.ts",
      "src/app/api/bookings/[id]/guests/route.ts",
    ];

    for (const path of sources) {
      const source = readRepoFile(path);

      expect(source).toContain("MembershipTypeBookingPolicyError");
      expect(source).toContain("error instanceof MembershipTypeBookingPolicyError");
      expect(source).toContain("throw error;");
    }
  });
});
