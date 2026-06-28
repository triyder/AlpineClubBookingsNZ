import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_MEMBERSHIP_TYPES,
  backfillCurrentSeasonMembershipAssignments,
  defaultMembershipTypeKeyForRole,
  ensureBuiltInMembershipTypes,
  normalizeMembershipTypeKey,
} from "@/lib/membership-types";
import { ROLE_VALUES } from "@/lib/member-roles";

function readRepoFile(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function makeDb() {
  return {
    membershipType: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([
        { id: "type-full", key: "FULL" },
        { id: "type-associate", key: "ASSOCIATE" },
        { id: "type-life", key: "LIFE" },
        { id: "type-reserve", key: "RESERVE" },
      ]),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([
        { id: "member-1", role: "MEMBER" },
        { id: "admin-1", role: "ADMIN" },
        { id: "lodge-1", role: "LODGE" },
        { id: "associate-1", role: "ASSOCIATE" },
        { id: "life-1", role: "LIFE" },
      ]),
    },
    seasonalMembershipAssignment: {
      createMany: vi.fn().mockResolvedValue({ count: 5 }),
    },
  };
}

describe("seasonal membership type schema contract", () => {
  it("adds durable membership type and seasonal assignment models without changing Role", () => {
    const schema = readRepoFile("prisma/schema.prisma");

    expect(schema).toContain("enum MembershipTypeBookingBehavior");
    expect(schema).toContain("MEMBER_RATE");
    expect(schema).toContain("NON_MEMBER_RATE");
    expect(schema).toContain("BLOCK_BOOKING");
    expect(schema).toContain("enum MembershipTypeSubscriptionBehavior");
    expect(schema).toContain("model MembershipType");
    expect(schema).toContain("key                  String");
    expect(schema).toContain("model SeasonalMembershipAssignment");
    expect(schema).toContain("@@unique([memberId, seasonYear])");
    expect(ROLE_VALUES).toEqual([
      "MEMBER",
      "ADMIN",
      "LODGE",
      "ASSOCIATE",
      "LIFE",
    ]);
    expect(ROLE_VALUES).not.toContain("COMMITTEE");
  });

  it("documents an expand-safe migration with built-in seeding and idempotent backfill", () => {
    const migration = readRepoFile(
      "prisma/migrations/20260628170000_add_seasonal_membership_types/migration.sql",
    );

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "MembershipType"');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "SeasonalMembershipAssignment"',
    );
    expect(migration).toContain("ON CONFLICT (\"key\") DO UPDATE");
    expect(migration).toContain(
      'ON CONFLICT ("memberId", "seasonYear") DO NOTHING',
    );
    expect(migration).toContain("WHEN 'ASSOCIATE' THEN 'ASSOCIATE'");
    expect(migration).toContain("WHEN 'LIFE' THEN 'LIFE'");
    expect(migration).not.toContain("COMMITTEE");
  });
});

describe("built-in membership type seed helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates required built-ins idempotently", async () => {
    const db = makeDb();

    await ensureBuiltInMembershipTypes(db);
    await ensureBuiltInMembershipTypes(db);

    expect(db.membershipType.upsert).toHaveBeenCalledTimes(
      BUILT_IN_MEMBERSHIP_TYPES.length * 2,
    );
    for (const type of BUILT_IN_MEMBERSHIP_TYPES) {
      expect(db.membershipType.upsert).toHaveBeenCalledWith({
        where: { key: type.key },
        update: {},
        create: expect.objectContaining({
          key: type.key,
          name: type.name,
          isActive: true,
          isBuiltIn: true,
          bookingBehavior: type.bookingBehavior,
          subscriptionBehavior: type.subscriptionBehavior,
        }),
      });
    }
  });

  it("maps existing roles to current-season membership assignments without overwriting", async () => {
    const db = makeDb();

    const result = await backfillCurrentSeasonMembershipAssignments(db, 2026);

    expect(result).toEqual({ createdCount: 5, seasonYear: 2026 });
    expect(db.seasonalMembershipAssignment.createMany).toHaveBeenCalledWith({
      data: [
        { memberId: "member-1", seasonYear: 2026, membershipTypeId: "type-full" },
        { memberId: "admin-1", seasonYear: 2026, membershipTypeId: "type-full" },
        { memberId: "lodge-1", seasonYear: 2026, membershipTypeId: "type-full" },
        {
          memberId: "associate-1",
          seasonYear: 2026,
          membershipTypeId: "type-associate",
        },
        { memberId: "life-1", seasonYear: 2026, membershipTypeId: "type-life" },
      ],
      skipDuplicates: true,
    });
  });

  it("keeps role-to-type defaults separate from access role semantics", () => {
    expect(defaultMembershipTypeKeyForRole("MEMBER")).toBe("FULL");
    expect(defaultMembershipTypeKeyForRole("ADMIN")).toBe("FULL");
    expect(defaultMembershipTypeKeyForRole("LODGE")).toBe("FULL");
    expect(defaultMembershipTypeKeyForRole("ASSOCIATE")).toBe("ASSOCIATE");
    expect(defaultMembershipTypeKeyForRole("LIFE")).toBe("LIFE");
  });

  it("derives stable custom keys without relying on display words for policy", () => {
    expect(normalizeMembershipTypeKey(" Social member ")).toBe("SOCIAL_MEMBER");
    expect(normalizeMembershipTypeKey("")).toBe("CUSTOM");
  });
});
