import { describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { lodgeConfigImporter } from "@/lib/config-transfer/categories/lodge-config";
import { xeroConfigImporter } from "@/lib/config-transfer/categories/xero-config";
import type { TxDb } from "@/lib/config-transfer/import-types";

// Config-transfer season-rate + Xero HUT_FEE re-key (#1930, E4): apply writes the
// membership-type-keyed rows, and OLD bundles carrying `isMember` still import
// (true -> FULL, false -> NON_MEMBER, documented lossy compat).

const MEMBERSHIP_TYPES = [
  { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-school", key: "SCHOOL_GROUP", bookingBehavior: "MEMBER_RATE", ageGroupsApply: false },
  { id: "mt-associate", key: "ASSOCIATE", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-blocked", key: "SOCIAL", bookingBehavior: "BLOCK_BOOKING", ageGroupsApply: true },
];

/**
 * A permissive in-memory tx: named delegates model the reads the apply needs;
 * any other delegate/method is a no-op so the apply's unrelated passes (rooms,
 * beds, instructions, default-lodge marker, …) don't throw. Captures the
 * membership-type-keyed creates we assert on.
 */
function makeTx(captures: {
  rateCreates: Record<string, unknown>[];
  itemCreates: Record<string, unknown>[];
}): TxDb {
  const noopDelegate = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async () => ({ id: "x" }),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => ({ id: "x" }),
  };
  const specific: Record<string, unknown> = {
    lodge: {
      ...noopDelegate,
      findMany: async () => [
        {
          id: "lodge-1", slug: "main", name: "Main Lodge", active: true, travelNote: null,
          doorCode: null, isDefault: true, displayConfig: null,
          displayNameGranularity: null, displayNotice: null, showGuestPhonesOnScreens: false,
        },
      ],
      findFirst: async () => ({ slug: "main" }),
      findUnique: async () => ({ isDefault: true }),
    },
    season: {
      ...noopDelegate,
      findMany: async () => [
        {
          id: "season-1", lodgeId: "lodge-1", name: "Winter", type: "WINTER",
          startDate: new Date("2026-06-01T00:00:00.000Z"),
          endDate: new Date("2026-09-01T00:00:00.000Z"), active: true,
        },
      ],
    },
    membershipTypeSeasonRate: {
      ...noopDelegate,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        captures.rateCreates.push(data);
        return { id: "r-new" };
      },
    },
    xeroItemCodeMapping: {
      ...noopDelegate,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        captures.itemCreates.push(data);
        return { id: "i-new" };
      },
    },
    membershipType: { ...noopDelegate, findMany: async () => MEMBERSHIP_TYPES },
  };
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => specific[prop as string] ?? noopDelegate,
  }) as unknown as TxDb;
}

function applyCtx(files: Map<string, Uint8Array>, tx: TxDb) {
  return {
    tx,
    files,
    manifest: {} as never,
    mode: "merge" as const,
    resolutions: new Map<string, string>(),
    actorMemberId: "admin-1",
    imageRemap: new Map<string, string>(),
    notes: { doorCodesWritten: [] as string[] },
  };
}

function lodgeFiles(ratesCsv: string): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["lodge-config/lodges/main/lodge.json", strToU8(JSON.stringify({ slug: "main", name: "Main Lodge" }))],
    ["lodge-config/lodges/main/seasons.csv", strToU8("name,type,startDate,endDate,active\nWinter,WINTER,2026-06-01,2026-09-01,true\n")],
    ["lodge-config/lodges/main/season-rates.csv", strToU8(ratesCsv)],
  ]);
}

describe("config-transfer season-rate re-key apply (#1930, E4)", () => {
  it("writes membership-type-keyed rows from the NEW-shape bundle", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = lodgeFiles(
      "seasonName,membershipTypeKey,ageTier,pricePerNightCents\n" +
      "Winter,FULL,ADULT,5000\n" +
      "Winter,NON_MEMBER,ADULT,7000\n",
    );
    await lodgeConfigImporter.apply(applyCtx(files, makeTx(captures)) as never);

    expect(captures.rateCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seasonId: "season-1", membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 5000 }),
        expect.objectContaining({ seasonId: "season-1", membershipTypeId: "mt-nonmember", ageTier: "ADULT", pricePerNightCents: 7000 }),
      ]),
    );
  });

  it("imports an OLD bundle: isMember true -> FULL, false -> NON_MEMBER", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = lodgeFiles(
      "seasonName,ageTier,isMember,pricePerNightCents\n" +
      "Winter,ADULT,true,5000\n" +
      "Winter,ADULT,false,7000\n",
    );
    await lodgeConfigImporter.apply(applyCtx(files, makeTx(captures)) as never);

    expect(captures.rateCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 5000 }),
        expect.objectContaining({ membershipTypeId: "mt-nonmember", ageTier: "ADULT", pricePerNightCents: 7000 }),
      ]),
    );
  });
});

function planCtx(files: Map<string, Uint8Array>, db: TxDb) {
  return {
    db,
    files,
    manifest: {} as never,
    mode: "merge" as const,
    resolutions: new Map<string, string>(),
  };
}

describe("config-transfer D2 + shape import validation (#1930, E4 review F9)", () => {
  it("season-rates: rejects rows targeting NON_MEMBER_RATE/BLOCK types as blocking errors", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = lodgeFiles(
      "seasonName,membershipTypeKey,ageTier,pricePerNightCents\n" +
      "Winter,ASSOCIATE,ADULT,5000\n" +
      "Winter,SOCIAL,ADULT,5000\n" +
      "Winter,FULL,ADULT,5000\n",
    );
    const plan = await lodgeConfigImporter.plan(planCtx(files, makeTx(captures)) as never);

    expect(plan.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('membership type "ASSOCIATE" does not carry its own hut rates'),
        expect.stringContaining('membership type "SOCIAL" does not carry its own hut rates'),
      ]),
    );
    // Invalid rows are excluded from the plan; the valid FULL row still plans.
    const rateItems = plan.items.filter((item) => item.entity === "season-rate");
    expect(rateItems).toHaveLength(1);
    expect(rateItems[0].key).toContain("FULL");
  });

  it("season-rates: validates row shape against ageGroupsApply", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = lodgeFiles(
      "seasonName,membershipTypeKey,ageTier,pricePerNightCents\n" +
      // Flat type must not carry a per-tier row...
      "Winter,SCHOOL_GROUP,ADULT,5000\n" +
      // ...and an age-keyed type must not carry a blank-tier (flat) row.
      "Winter,FULL,,5000\n" +
      // Correct shapes still plan.
      "Winter,SCHOOL_GROUP,,4000\n" +
      "Winter,FULL,ADULT,6000\n",
    );
    const plan = await lodgeConfigImporter.plan(planCtx(files, makeTx(captures)) as never);

    expect(plan.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"SCHOOL_GROUP" prices from a single flat rate'),
        expect.stringContaining('"FULL" uses per-age-tier rates'),
      ]),
    );
    const rateItems = plan.items.filter((item) => item.entity === "season-rate");
    expect(rateItems.map((item) => item.key)).toEqual([
      "main/Winter/SCHOOL_GROUP/",
      "main/Winter/FULL/ADULT",
    ]);
  });

  it("xero HUT_FEE: rejects non-rate-bearing types and shape mismatches as blocking errors", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = new Map<string, Uint8Array>([
      ["xero-config/item-code-mappings.csv", strToU8(
        "category,membershipTypeKey,ageTier,seasonType,entranceFeeCategory,itemCode,amountCents\n" +
        "HUT_FEE,ASSOCIATE,ADULT,WINTER,,HUT-BAD,\n" +
        "HUT_FEE,SCHOOL_GROUP,ADULT,WINTER,,HUT-BAD-SHAPE,\n" +
        "HUT_FEE,FULL,,WINTER,,HUT-BAD-FLAT,\n" +
        "HUT_FEE,FULL,ADULT,WINTER,,HUT-OK,\n" +
        "HUT_FEE,SCHOOL_GROUP,,WINTER,,HUT-OK-FLAT,\n" +
        "ENTRANCE_FEE,,,,ADULT,ENT-OK,5000\n",
      )],
    ]);
    const plan = await xeroConfigImporter.plan(planCtx(files, makeTx(captures)) as never);

    expect(plan.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('membership type "ASSOCIATE" does not carry its own hut fees'),
        expect.stringContaining('"SCHOOL_GROUP" prices from a single flat rate'),
        expect.stringContaining('"FULL" uses per-age-tier rates'),
      ]),
    );
    // Valid rows (incl. ENTRANCE_FEE, which never carries a membership type)
    // still plan; invalid ones are excluded.
    const itemKeys = plan.items
      .filter((item) => item.entity === "xero-item-code-mapping")
      .map((item) => item.key);
    expect(itemKeys).toEqual(
      expect.arrayContaining([
        "HUT_FEE/FULL/ADULT/WINTER/-",
        "HUT_FEE/SCHOOL_GROUP/-/WINTER/-",
        "ENTRANCE_FEE/-/-/-/ADULT",
      ]),
    );
    expect(itemKeys).toHaveLength(3);
  });
});

describe("config-transfer Xero HUT_FEE re-key apply (#1930, E4)", () => {
  it("imports an OLD HUT_FEE bundle: isMember maps to FULL / NON_MEMBER membershipTypeId", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = new Map<string, Uint8Array>([
      ["xero-config/item-code-mappings.csv", strToU8(
        "category,ageTier,seasonType,isMember,entranceFeeCategory,itemCode,amountCents\n" +
        "HUT_FEE,ADULT,WINTER,true,,HUT-MEM,\n" +
        "HUT_FEE,ADULT,WINTER,false,,HUT-NON,\n",
      )],
    ]);
    await xeroConfigImporter.apply(applyCtx(files, makeTx(captures)) as never);

    expect(captures.itemCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "HUT_FEE", membershipTypeId: "mt-full", ageTier: "ADULT", seasonType: "WINTER", itemCode: "HUT-MEM" }),
        expect.objectContaining({ category: "HUT_FEE", membershipTypeId: "mt-nonmember", ageTier: "ADULT", seasonType: "WINTER", itemCode: "HUT-NON" }),
      ]),
    );
    // Legacy isMember column is not carried onto the new-key row.
    for (const created of captures.itemCreates) {
      expect(created.isMember ?? null).toBeNull();
    }
  });
});
