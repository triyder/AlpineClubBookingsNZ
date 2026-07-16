import { describe, expect, it, vi } from "vitest";
import { buildMemberMergePreview } from "@/lib/member-merge";

const MASTER_ID = "master-1";
const LOSER_ID = "loser-1";
const ACTOR_ID = "admin-1";

function makeMember(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    email: `${id}@example.com`,
    firstName: id === LOSER_ID ? "Dup" : "Real",
    lastName: "Person",
    active: true,
    archivedAt: null,
    canLogin: true,
    xeroContactId: null,
    joinedDate: null,
    parentMemberId: null,
    secondaryParentId: null,
    inheritEmailFromId: null,
    detailsConfirmedByMemberId: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2021-01-01T00:00:00Z"),
    requiresInduction: false,
    hutLeaderEligible: false,
    hutLeaderEligibleAt: null,
    ...overrides,
  };
}

function defaultDelegate() {
  return {
    count: vi.fn().mockResolvedValue(0),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
  };
}

function makeDb(params: {
  master?: Record<string, unknown>;
  loser?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}) {
  const master = params.master ?? makeMember(MASTER_ID);
  const loser = params.loser ?? makeMember(LOSER_ID);
  const overrides = params.overrides ?? {};
  const memberDelegate = {
    ...defaultDelegate(),
    findUnique: vi.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === MASTER_ID ? master : where.id === LOSER_ID ? loser : null,
      ),
    ),
    // actorIsFullAdmin -> 1 for the actor; wouldRemoveLastFullAdmin(loser) -> 0;
    // self-relation move-count queries (no `id` in where) -> 0.
    count: vi.fn(({ where }: { where: { id?: string } }) =>
      Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
    ),
  };
  const cache = new Map<string, unknown>();
  cache.set("member", overrides.member ?? memberDelegate);
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in overrides) return overrides[prop as keyof typeof overrides];
        if (!cache.has(prop)) cache.set(prop, defaultDelegate());
        return cache.get(prop);
      },
    },
  );
}

async function preview(params: {
  master?: Record<string, unknown>;
  loser?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}) {
  return buildMemberMergePreview({
    masterId: MASTER_ID,
    loserId: LOSER_ID,
    actorMemberId: ACTOR_ID,
    db: makeDb(params) as never,
  });
}

describe("buildMemberMergePreview warnings", () => {
  it("includes definition-backed custom roles in the gained-role warning (M1)", async () => {
    const memberAccessRole = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { memberId: string } }) =>
        Promise.resolve(
          where.memberId === LOSER_ID
            ? [
                {
                  role: null,
                  roleDefinitionId: "def-fin",
                  roleDefinition: { label: "Finance Manager" },
                },
              ]
            : [],
        ),
      ),
    };
    const result = await preview({ overrides: { memberAccessRole } });
    expect(result.blockers).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes("Master will gain access role(s)") &&
          w.includes("Finance Manager (custom role)"),
      ),
    ).toBe(true);
  });

  it("still lists gained enum roles alongside custom ones", async () => {
    const memberAccessRole = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { memberId: string } }) =>
        Promise.resolve(
          where.memberId === LOSER_ID
            ? [
                { role: "FINANCE_ADMIN", roleDefinitionId: null, roleDefinition: null },
                {
                  role: null,
                  roleDefinitionId: "def-x",
                  roleDefinition: { label: "Custom Ops" },
                },
              ]
            : [],
        ),
      ),
    };
    const result = await preview({ overrides: { memberAccessRole } });
    const warning = result.warnings.find((w) => w.includes("Master will gain"));
    expect(warning).toContain("FINANCE_ADMIN");
    expect(warning).toContain("Custom Ops (custom role)");
  });

  it("surfaces the CONFIRMED partner-link drop warning and counts memberB-side loser links (M3/m2)", async () => {
    // The loser sits on the memberB side of its link (A < B canonical order),
    // which the old memberA-only count missed entirely.
    const loserLinks = [
      { id: "L1", memberAId: "aaa-third", memberBId: LOSER_ID, status: "CONFIRMED" },
    ];
    const masterLinks = [
      { id: "M1", memberAId: MASTER_ID, memberBId: "zzz-partner", status: "CONFIRMED" },
    ];
    const memberPartnerLink = {
      ...defaultDelegate(),
      findMany: vi.fn(
        ({ where }: { where: { OR: { memberAId?: string; memberBId?: string }[] } }) =>
          Promise.resolve(
            where.OR?.[0]?.memberAId === LOSER_ID ? loserLinks : masterLinks,
          ),
      ),
    };
    const result = await preview({ overrides: { memberPartnerLink } });
    expect(
      result.warnings.some((w) => w.includes("confirmed partner link dropped")),
    ).toBe(true);
    const collision = result.collisions.find(
      (c) => c.model === "MemberPartnerLink.memberA/memberB",
    );
    expect(collision?.count).toBe(1);
  });

  it("warns that the loser's own outbound self-relation links are discarded (m4)", async () => {
    const result = await preview({
      loser: makeMember(LOSER_ID, {
        parentMemberId: "someone-else",
        inheritEmailFromId: "someone-else",
      }),
    });
    const warning = result.warnings.find((w) => w.includes("discarded"));
    expect(warning).toBeDefined();
    expect(warning).toContain("parent");
    expect(warning).toContain("inheritEmailFrom");
  });

  it("does not warn about a loser self-relation that points at the master (deleted self-cycle)", async () => {
    const result = await preview({
      loser: makeMember(LOSER_ID, { parentMemberId: MASTER_ID }),
    });
    expect(result.warnings.some((w) => w.includes("discarded"))).toBe(false);
  });

  it("adds a specific note when duplicate promo-money allocation rows will be dropped (m5)", async () => {
    const promoRedemptionAllocation = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { memberId: string } }) =>
        Promise.resolve(
          where.memberId === LOSER_ID
            ? [{ id: "pa-L", promoRedemptionId: "pr1", promoCodeId: "pc1", bookingId: "b1" }]
            : [{ id: "pa-M", promoRedemptionId: "pr1", promoCodeId: "pcM", bookingId: "bM" }],
        ),
      ),
    };
    const result = await preview({ overrides: { promoRedemptionAllocation } });
    expect(
      result.warnings.some((w) =>
        w.includes("promo redemption allocation row(s) will be dropped"),
      ),
    ).toBe(true);
  });

  it("adds a specific note when duplicate group-booking join rows will be dropped (m5)", async () => {
    const groupBookingJoin = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { joinerMemberId: string } }) =>
        Promise.resolve(
          where.joinerMemberId === LOSER_ID
            ? [{ id: "gj-L", groupBookingId: "gb1" }]
            : [{ id: "gj-M", groupBookingId: "gb1" }],
        ),
      ),
    };
    const result = await preview({ overrides: { groupBookingJoin } });
    expect(
      result.warnings.some((w) =>
        w.includes("group-booking join row(s) will be dropped"),
      ),
    ).toBe(true);
  });

  it("always warns about manual Xero cleanup timing loser sign-out", async () => {
    const result = await preview({});
    expect(
      result.warnings.some((w) => w.includes("signed out on their next request")),
    ).toBe(true);
  });
});
