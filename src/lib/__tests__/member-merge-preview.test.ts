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
});
