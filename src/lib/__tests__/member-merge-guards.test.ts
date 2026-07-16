import { describe, expect, it, vi } from "vitest";
import { evaluateMemberMergeGuards } from "@/lib/member-merge";

const MASTER_ID = "master-1";
const LOSER_ID = "loser-1";
const ACTOR_ID = "admin-1";

function guardMember(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    active: true,
    archivedAt: null,
    firstName: id === LOSER_ID ? "Dup" : "Real",
    lastName: "Person",
    email: `${id}@example.com`,
    accessRoles: [] as { role: string | null }[],
    ...overrides,
  };
}

function defaultDelegate() {
  return {
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
  };
}

/**
 * Proxy mock db: member.count answers the actorIsFullAdmin /
 * wouldRemoveLastFullAdmin queries; other delegates default to zero counts and
 * empty findMany unless overridden.
 */
function makeDb(overrides: Record<string, unknown> = {}) {
  const memberDelegate = {
    ...defaultDelegate(),
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

async function runGuards(dbOverrides: Record<string, unknown> = {}) {
  return evaluateMemberMergeGuards({
    db: makeDb(dbOverrides) as never,
    actorMemberId: ACTOR_ID,
    master: guardMember(MASTER_ID) as never,
    loser: guardMember(LOSER_ID) as never,
    masterId: MASTER_ID,
    loserId: LOSER_ID,
  });
}

/**
 * A memberSubscription.findMany mock: the guard queries the MASTER for ALL
 * rows (no OR filter) and the LOSER for MEANINGFUL rows only (OR filter
 * present), so the mock keys off `where.OR` to emulate meaningfulness.
 */
function subscriptionFindMany(config: {
  masterSeasons: number[];
  loserMeaningfulSeasons: number[];
}) {
  return vi.fn(({ where }: { where: { memberId: string; OR?: unknown } }) => {
    if (where.memberId === MASTER_ID && !where.OR) {
      return Promise.resolve(config.masterSeasons.map((seasonYear) => ({ seasonYear })));
    }
    if (where.memberId === LOSER_ID && where.OR) {
      return Promise.resolve(
        config.loserMeaningfulSeasons.map((seasonYear) => ({ seasonYear })),
      );
    }
    return Promise.resolve([]);
  });
}

describe("subscription-collision blocker (B1 matrix)", () => {
  it("BLOCKS master-meaningless + loser-meaningful for the same season (paid history must never be dropped)", async () => {
    // Master holds a meaningless NOT_INVOICED 2026 row (still a row for the
    // season); loser holds a PAID 2026 row with an invoice link (meaningful).
    const blockers = await runGuards({
      memberSubscription: {
        ...defaultDelegate(),
        findMany: subscriptionFindMany({
          masterSeasons: [2026],
          loserMeaningfulSeasons: [2026],
        }),
      },
    });
    expect(blockers.map((b) => b.code)).toContain("subscription_collision");
  });

  it("BLOCKS a colliding loser row backed by charge coverage (never a late P2003)", async () => {
    // A coverage-backed loser row is meaningful via chargeCoverage even when
    // NOT_INVOICED with no Xero fields; dropping it would P2003 on the
    // onDelete:Restrict MembershipSubscriptionChargeCoverage FK.
    const blockers = await runGuards({
      memberSubscription: {
        ...defaultDelegate(),
        findMany: subscriptionFindMany({
          masterSeasons: [2025],
          loserMeaningfulSeasons: [2025],
        }),
      },
    });
    expect(blockers.map((b) => b.code)).toContain("subscription_collision");
  });

  it("does NOT block both-meaningless for the same season (loser row is droppable)", async () => {
    const blockers = await runGuards({
      memberSubscription: {
        ...defaultDelegate(),
        findMany: subscriptionFindMany({
          masterSeasons: [2026],
          loserMeaningfulSeasons: [], // loser's colliding row is meaningless
        }),
      },
    });
    expect(blockers).toEqual([]);
  });

  it("does NOT block a loser-only meaningful subscription (no master row for the season -> moved)", async () => {
    const blockers = await runGuards({
      memberSubscription: {
        ...defaultDelegate(),
        findMany: subscriptionFindMany({
          masterSeasons: [2024],
          loserMeaningfulSeasons: [2026],
        }),
      },
    });
    expect(blockers).toEqual([]);
  });
});

describe("pending DeletionRequest blocker (M2)", () => {
  it("blocks when the LOSER has a PENDING account-deletion request", async () => {
    const deletionRequest = {
      ...defaultDelegate(),
      count: vi.fn(({ where }: { where: { memberId: string; status: string } }) =>
        Promise.resolve(where.memberId === LOSER_ID && where.status === "PENDING" ? 1 : 0),
      ),
    };
    const blockers = await runGuards({ deletionRequest });
    expect(blockers.map((b) => b.code)).toContain("loser_pending_requests");
    expect(blockers.map((b) => b.code)).not.toContain("master_pending_requests");
  });

  it("blocks when the MASTER has a PENDING account-deletion request", async () => {
    const deletionRequest = {
      ...defaultDelegate(),
      count: vi.fn(({ where }: { where: { memberId: string; status: string } }) =>
        Promise.resolve(where.memberId === MASTER_ID && where.status === "PENDING" ? 1 : 0),
      ),
    };
    const blockers = await runGuards({ deletionRequest });
    expect(blockers.map((b) => b.code)).toContain("master_pending_requests");
    expect(blockers.map((b) => b.code)).not.toContain("loser_pending_requests");
  });

  it("only PENDING deletion requests block (queries filter on status)", async () => {
    const deletionRequest = {
      ...defaultDelegate(),
      count: vi.fn(({ where }: { where: { status?: string } }) => {
        expect(where.status).toBe("PENDING");
        return Promise.resolve(0);
      }),
    };
    const blockers = await runGuards({ deletionRequest });
    expect(blockers).toEqual([]);
    expect(deletionRequest.count).toHaveBeenCalledTimes(2); // master AND loser
  });
});
