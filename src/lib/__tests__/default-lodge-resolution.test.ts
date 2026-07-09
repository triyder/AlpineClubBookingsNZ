import { describe, expect, it, vi } from "vitest";
import { getDefaultLodgeId } from "@/lib/lodges";
import type { PrismaClient } from "@prisma/client";

type FakeLodge = {
  id: string;
  active: boolean;
  isDefault: boolean;
  createdAt: Date;
};

// Minimal in-memory stand-in for prisma.lodge.findFirst that honours the three
// query shapes getDefaultLodgeId issues: { where: { isDefault: true } }, then
// { where: { active: true }, orderBy: createdAt asc / id asc }, then the same
// order with no where. Enough to prove which lodge each resolution path picks.
function makeDb(lodges: FakeLodge[]) {
  const findFirst = vi.fn(
    async (args: {
      where?: { isDefault?: boolean; active?: boolean };
      orderBy?: unknown;
    }) => {
      let rows = [...lodges];
      if (args.where?.isDefault === true) {
        rows = rows.filter((lodge) => lodge.isDefault);
      }
      if (args.where?.active === true) {
        rows = rows.filter((lodge) => lodge.active);
      }
      if (args.orderBy) {
        rows.sort((a, b) => {
          const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
          if (byCreated !== 0) return byCreated;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
      }
      return rows[0] ? { id: rows[0].id } : null;
    },
  );
  return {
    db: { lodge: { findFirst } } as unknown as Pick<PrismaClient, "lodge">,
    findFirst,
  };
}

describe("getDefaultLodgeId durable resolution (#1656 / #1627 option b)", () => {
  it("resolves the isDefault-flagged lodge even when another lodge has an earlier createdAt", async () => {
    // The #1627 inversion shape: a lodge created inside the seed's TZ-skew
    // window ("skew") sorts BEFORE the genuine seeded lodge ("seed"). Under the
    // old earliest-createdAt ordering that flipped the default to "skew"; the
    // isDefault flag must now pin it to "seed" regardless of createdAt.
    const { db, findFirst } = makeDb([
      {
        id: "seed",
        active: true,
        isDefault: true,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        id: "skew",
        active: true,
        isDefault: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    expect(await getDefaultLodgeId(db)).toBe("seed");
    // The flag alone resolves it; the createdAt-ordered fallback is never hit.
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: { isDefault: true },
      select: { id: true },
    });
  });

  it("falls back to the oldest active lodge when no lodge is flagged (pre-backfill data)", async () => {
    // Data that predates the flag (no isDefault true) must resolve exactly as the
    // old code did: oldest active lodge.
    const { db } = makeDb([
      {
        id: "younger",
        active: true,
        isDefault: false,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        id: "older",
        active: true,
        isDefault: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    expect(await getDefaultLodgeId(db)).toBe("older");
  });

  it("falls back to the oldest lodge of any state when none is active or flagged", async () => {
    const { db } = makeDb([
      {
        id: "inactive-newer",
        active: false,
        isDefault: false,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        id: "inactive-older",
        active: false,
        isDefault: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    expect(await getDefaultLodgeId(db)).toBe("inactive-older");
  });

  it("keeps the flagged lodge as default even when it is inactive (reassign before deactivating)", async () => {
    // A flagged-but-inactive lodge deliberately stays the default rather than
    // silently falling through to createdAt ordering, keeping the TS and SQL
    // sides in agreement.
    const { db } = makeDb([
      {
        id: "flagged-inactive",
        active: false,
        isDefault: true,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        id: "active-older",
        active: true,
        isDefault: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    expect(await getDefaultLodgeId(db)).toBe("flagged-inactive");
  });

  it("throws when no lodge exists", async () => {
    const { db } = makeDb([]);
    await expect(getDefaultLodgeId(db)).rejects.toThrow(/No Lodge row exists/);
  });
});
