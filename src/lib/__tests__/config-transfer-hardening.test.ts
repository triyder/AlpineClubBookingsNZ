import { describe, expect, it, vi } from "vitest";
import { zipSync, unzipSync, strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import {
  buildBundle,
  readBundle,
  resealBundle,
  type BundleEntry,
} from "@/lib/config-transfer/bundle";
import { buildImportPlan } from "@/lib/config-transfer/import";
import { serialiseCsv } from "@/lib/config-transfer/csv";
import {
  PAGE_CONTENT_FIELDS,
  siteContentImporter,
} from "@/lib/config-transfer/categories/site-content";
import type { ReadDb, TxDb } from "@/lib/config-transfer/import-types";

// Hardening behaviours: plan-time validation errors that BLOCK apply, the
// fingerprint binding (bundle bytes / mode / selection / resolutions), the
// null-honest Xero item identity, media caps, zip-bomb caps, wrapper-discard
// and category-coverage warnings, door-code disclosure, and the match picker.

const GENERATED_AT = "2026-07-10T00:00:00.000Z";

function bundleOf(
  entries: BundleEntry[],
  includedCategories: Parameters<typeof buildBundle>[0]["includedCategories"],
  doorCodesIncluded = false,
): Uint8Array {
  return buildBundle({
    entries,
    appVersion: "0.10.1",
    prismaMigration: null,
    includedCategories,
    doorCodesIncluded,
    generatedAt: GENERATED_AT,
  });
}

function lodgeBundle(options: {
  lodgeJson?: Record<string, unknown>;
  seasonsCsv?: string;
  ratesCsv?: string;
}): Uint8Array {
  const entries: BundleEntry[] = [
    {
      path: "lodge-config/lodges/main/lodge.json",
      category: "lodge-config",
      rowCount: null,
      bytes: strToU8(
        JSON.stringify(
          options.lodgeJson ?? { slug: "main", name: "Main Lodge", active: true, travelNote: null, isDefault: false },
        ),
      ),
    },
  ];
  if (options.seasonsCsv !== undefined) {
    entries.push({
      path: "lodge-config/lodges/main/seasons.csv",
      category: "lodge-config",
      rowCount: 1,
      bytes: strToU8(options.seasonsCsv),
    });
  }
  if (options.ratesCsv !== undefined) {
    entries.push({
      path: "lodge-config/lodges/main/season-rates.csv",
      category: "lodge-config",
      rowCount: 1,
      bytes: strToU8(options.ratesCsv),
    });
  }
  return bundleOf(entries, ["lodge-config"]);
}

const EXISTING_SEASON = {
  id: "season-1",
  lodgeId: "lodge-1",
  name: "Winter",
  type: "WINTER",
  startDate: new Date("2026-06-01T00:00:00.000Z"),
  endDate: new Date("2026-09-01T00:00:00.000Z"),
  active: true,
};

function lodgeDb(overrides?: {
  lodges?: unknown[];
  seasons?: unknown[];
  defaultLodge?: { slug: string } | null;
}): ReadDb {
  return {
    lodge: {
      findMany: vi.fn().mockResolvedValue(
        overrides?.lodges ?? [
          { id: "lodge-1", slug: "main", name: "Main Lodge", active: true, travelNote: null, doorCode: null, isDefault: true },
        ],
      ),
      findFirst: vi.fn().mockResolvedValue(overrides?.defaultLodge ?? { slug: "main" }),
    },
    lodgeRoom: { findMany: vi.fn().mockResolvedValue([]) },
    lodgeBed: { findMany: vi.fn().mockResolvedValue([]) },
    season: { findMany: vi.fn().mockResolvedValue(overrides?.seasons ?? []) },
    seasonRate: { findMany: vi.fn().mockResolvedValue([]) },
    lodgeInstruction: { findMany: vi.fn().mockResolvedValue([]) },
    choreTemplate: { findMany: vi.fn().mockResolvedValue([]) },
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as ReadDb;
}

describe("plan-time validation blocks apply", () => {
  it("flags a malformed season date as an error (never a clean create)", async () => {
    const zip = lodgeBundle({
      seasonsCsv: "name,type,startDate,endDate,active\nWinter,WINTER,2026-06-01,,true\n",
    });
    const plan = await buildImportPlan(lodgeDb(), zip, { mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(/endDate/);
    // The invalid row is excluded from the plan items.
    expect(plan.categories.flatMap((c) => c.items).some((i) => i.entity === "season")).toBe(false);
  });

  it("flags a typo'd enum with the valid options named", async () => {
    const zip = lodgeBundle({
      seasonsCsv: "name,type,startDate,endDate,active\nWinter,WNITER,2026-06-01,2026-09-01,true\n",
    });
    const plan = await buildImportPlan(lodgeDb(), zip, { mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(/WNITER.*WINTER/);
  });

  it("flags a blank or garbage price instead of writing 0 cents", async () => {
    const zip = lodgeBundle({
      seasonsCsv: "name,type,startDate,endDate,active\nWinter,WINTER,2026-06-01,2026-09-01,true\n",
      ratesCsv: "seasonName,ageTier,isMember,pricePerNightCents\nWinter,ADULT,true,4S50\n",
    });
    const plan = await buildImportPlan(lodgeDb(), zip, { mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(/pricePerNightCents.*4S50/);
  });

  it("allows blank typed cells in merge mode when the row already exists", async () => {
    const zip = lodgeBundle({
      seasonsCsv: "name,type,startDate,endDate,active\nWinter,,,,\n",
    });
    const plan = await buildImportPlan(
      lodgeDb({ seasons: [EXISTING_SEASON] }),
      zip,
      { mode: "merge" },
    );
    expect(plan.errors).toEqual([]);
    const season = plan.categories.flatMap((c) => c.items).find((i) => i.entity === "season");
    expect(season?.action).toBe("unchanged"); // blanks keep existing values
  });

  it("rejects the same blank cells in overwrite mode", async () => {
    const zip = lodgeBundle({
      seasonsCsv: "name,type,startDate,endDate,active\nWinter,,,,\n",
    });
    const plan = await buildImportPlan(
      lodgeDb({ seasons: [EXISTING_SEASON] }),
      zip,
      { mode: "overwrite" },
    );
    expect(plan.errors.length).toBeGreaterThan(0);
  });
});

// ---- site-content page hardening --------------------------------------------
// The import must apply the SAME slug rules as the admin page-content route,
// derive the path from the slug, and store headerText sanitised (issue #1712).

const BASE_PAGE = {
  slug: "about",
  path: "/about",
  caption: "",
  menuTitle: "About",
  title: "About Us",
  headerText: "",
  sortOrder: 1,
  contentHtml: "<p>Hi</p>",
  published: true,
};

function pagesBundle(rows: Array<Record<string, unknown>>): Uint8Array {
  return bundleOf(
    [
      {
        path: "site-content/pages.csv",
        category: "site-content",
        rowCount: rows.length,
        bytes: strToU8(serialiseCsv([...PAGE_CONTENT_FIELDS], rows)),
      },
    ],
    ["site-content"],
  );
}

function pagesDb(existingPages: Array<Record<string, unknown>>): ReadDb {
  return {
    pageContent: { findMany: vi.fn().mockResolvedValue(existingPages) },
    siteContent: { findMany: vi.fn().mockResolvedValue([]) },
    clubTheme: { findUnique: vi.fn().mockResolvedValue(null) },
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as ReadDb;
}

/** In-memory pageContent store + apply context for the site-content importer. */
function pagesApplyHarness(bundle: Uint8Array) {
  const pages = new Map<string, Record<string, unknown>>();
  const tx = {
    pageContent: {
      findMany: async () => [...pages.values()],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        pages.set(String(data.slug), { ...data });
      },
      update: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const key = String(where.slug);
        pages.set(key, { ...(pages.get(key) ?? {}), ...data });
      },
    },
    siteContent: { findMany: async () => [] },
    clubTheme: { findUnique: async () => null },
  } as unknown as TxDb;
  const { manifest, files } = readBundle(bundle);
  return {
    pages,
    ctx: {
      tx,
      files,
      manifest,
      mode: "overwrite" as const,
      resolutions: new Map<string, string>(),
      actorMemberId: "admin-1",
      imageRemap: new Map<string, string>(),
      notes: { doorCodesWritten: [] as string[] },
    },
  };
}

describe("site-content page hardening (slug/path/headerText)", () => {
  it("flags an invalid page slug as a row error and excludes the row", async () => {
    const zip = pagesBundle([{ ...BASE_PAGE, slug: "Bad Slug", path: "/bad" }]);
    const plan = await buildImportPlan(pagesDb([]), zip, { mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(
      /pages\.csv row 2: slug — "Bad Slug" is not a valid page slug/,
    );
    expect(plan.categories.flatMap((c) => c.items)).toEqual([]);
  });

  it("flags a reserved slug segment (admin route parity)", async () => {
    const zip = pagesBundle([
      { ...BASE_PAGE, slug: "admin/settings", path: "/admin/settings" },
    ]);
    const plan = await buildImportPlan(pagesDb([]), zip, { mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(/slug — .*reserved route segment/);
    expect(plan.categories.flatMap((c) => c.items)).toEqual([]);
  });

  it("derives the path from the slug instead of trusting the file", async () => {
    // Plan: a crafted path cell on an otherwise-identical row is NOT a change.
    const zip = pagesBundle([{ ...BASE_PAGE, path: "/evil" }]);
    const plan = await buildImportPlan(
      pagesDb([{ id: "p1", ...BASE_PAGE }]),
      zip,
      { mode: "overwrite" },
    );
    expect(plan.errors).toEqual([]);
    expect(plan.categories[0].items[0].action).toBe("unchanged");

    // Apply (create): the stored path is derived from the slug.
    const { pages, ctx } = pagesApplyHarness(zip);
    await siteContentImporter.apply(ctx);
    expect(pages.get("about")?.path).toBe("/about");
  });

  it("stores headerText sanitised, exactly like the admin write path", async () => {
    const zip = pagesBundle([
      { ...BASE_PAGE, headerText: "<script>alert(1)</script><p>Hi</p>" },
    ]);

    // Apply (create): the script tag never reaches the database.
    const { pages, ctx } = pagesApplyHarness(zip);
    await siteContentImporter.apply(ctx);
    expect(pages.get("about")?.headerText).toBe("<p>Hi</p>");

    // Plan diffs against the sanitised value: an existing row that already
    // holds the sanitised form is "unchanged", not a spurious update.
    const plan = await buildImportPlan(
      pagesDb([{ id: "p1", ...BASE_PAGE, headerText: "<p>Hi</p>" }]),
      zip,
      { mode: "overwrite" },
    );
    expect(plan.errors).toEqual([]);
    expect(plan.categories[0].items[0].action).toBe("unchanged");
  });
});

describe("fingerprint binding", () => {
  it("differs by mode, bundle bytes, and selection", async () => {
    const zip = lodgeBundle({});
    const merge = await buildImportPlan(lodgeDb(), zip, { mode: "merge" });
    const overwrite = await buildImportPlan(lodgeDb(), zip, { mode: "overwrite" });
    expect(merge.fingerprint).not.toBe(overwrite.fingerprint);

    // Same keys, different bytes (travelNote differs) → different fingerprint.
    const zip2 = lodgeBundle({
      lodgeJson: { slug: "main", name: "Main Lodge", active: true, travelNote: "edited", isDefault: false },
    });
    const other = await buildImportPlan(lodgeDb(), zip2, { mode: "merge" });
    expect(other.fingerprint).not.toBe(merge.fingerprint);

    // Deterministic for identical inputs.
    const again = await buildImportPlan(lodgeDb(), zip, { mode: "merge" });
    expect(again.fingerprint).toBe(merge.fingerprint);
  });
});

describe("door-code disclosure", () => {
  it("names the lodge whose door code would be set", async () => {
    const zip = lodgeBundle({
      lodgeJson: { slug: "main", name: "Main Lodge", active: true, doorCode: "4271", isDefault: false },
    });
    const plan = await buildImportPlan(lodgeDb(), zip, { mode: "merge" });
    expect(plan.doorCodeChanges).toEqual(["main"]);
    expect(
      plan.categories.flatMap((c) => c.warnings).join(" "),
    ).toMatch(/door code for lodge "main" will be set/i);
  });
});

describe("match picker (key-weak renames)", () => {
  it("offers candidates for an unmatched season and honours a resolution", async () => {
    const zip = lodgeBundle({
      seasonsCsv: "name,type,startDate,endDate,active\nWinter 2026,WINTER,2026-06-01,2026-09-01,true\n",
    });
    const db = () => lodgeDb({ seasons: [EXISTING_SEASON] });

    // Unresolved: the unmatched bundle row offers "Winter" as a candidate.
    const plan = await buildImportPlan(db(), zip, { mode: "merge" });
    const item = plan.categories.flatMap((c) => c.items).find((i) => i.entity === "season");
    expect(item?.action).toBe("create");
    expect(item?.candidates?.[0]).toMatchObject({ id: "season-1" });

    // Resolved: the row becomes an update (rename) of the matched season.
    const resolved = await buildImportPlan(db(), zip, {
      mode: "merge",
      resolutions: [{ entity: "season", key: "main/Winter 2026", matchId: "season-1" }],
    });
    const resolvedItem = resolved.categories.flatMap((c) => c.items).find((i) => i.entity === "season");
    expect(resolvedItem?.action).toBe("update");
    expect(resolvedItem?.changedFields).toContain("name");
    // Resolutions are fingerprint-bound.
    expect(resolved.fingerprint).not.toBe(plan.fingerprint);
  });
});

describe("xero item identity is null-honest", () => {
  it("matches an existing null-isMember row instead of duplicating it", async () => {
    const db = {
      xeroAccountMapping: { findMany: vi.fn().mockResolvedValue([]) },
      xeroItemCodeMapping: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "item-1", category: "HUT_FEE", ageTier: "ADULT", seasonType: "WINTER",
            isMember: null, entranceFeeCategory: null, itemCode: "HUT-A", amountCents: null,
          },
        ]),
      },
      xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as ReadDb;
    const zip = bundleOf(
      [
        {
          path: "xero-config/item-code-mappings.csv",
          category: "xero-config",
          rowCount: 1,
          bytes: strToU8(
            "category,ageTier,seasonType,isMember,entranceFeeCategory,itemCode,amountCents\nHUT_FEE,ADULT,WINTER,,,HUT-A,\n",
          ),
        },
      ],
      ["xero-config"],
    );
    const plan = await buildImportPlan(db, zip, { mode: "merge" });
    const item = plan.categories.flatMap((c) => c.items).find((i) => i.entity === "xero-item-code-mapping");
    // The blank-isMember row matches the existing null row → unchanged, NOT a
    // duplicate create (the old compound-unique probe coerced null→false).
    expect(item?.action).toBe("unchanged");
  });
});

describe("xero target-org binding", () => {
  it("fingerprints the TARGET org so a connect/switch between preview and apply drifts", async () => {
    const zip = bundleOf(
      [
        {
          path: "xero-config/account-mappings.csv",
          category: "xero-config",
          rowCount: 1,
          bytes: strToU8("key,code,itemCode\nhutFeesIncome,200,\n"),
        },
      ],
      ["xero-config"],
    );
    const dbWithTenant = (tenantId: string | null) =>
      ({
        xeroAccountMapping: { findMany: vi.fn().mockResolvedValue([]) },
        xeroItemCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
        xeroToken: {
          findFirst: vi
            .fn()
            .mockResolvedValue(tenantId ? { tenantId } : null),
        },
      }) as unknown as ReadDb;

    const disconnected = await buildImportPlan(dbWithTenant(null), zip, { mode: "merge" });
    const connected = await buildImportPlan(dbWithTenant("org-a"), zip, { mode: "merge" });
    expect(connected.fingerprint).not.toBe(disconnected.fingerprint);
  });
});

describe("bundle resource limits + coverage warnings", () => {
  it("rejects too many entries before inflating them", () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 2100; i += 1) entries[`site-content/f${i}.csv`] = strToU8("x");
    expect(() => readBundle(zipSync(entries))).toThrow(/too many files/i);
  });

  it("warns when the wrapper-strip discards a root-level file", () => {
    const zip = lodgeBundle({});
    const wrapped: Record<string, Uint8Array> = { "stray.txt": strToU8("note") };
    for (const [name, bytes] of Object.entries(unzipSync(zip))) {
      wrapped[`bundle/${name}`] = bytes;
    }
    const { warnings } = readBundle(zipSync(wrapped));
    expect(warnings.join(" ")).toMatch(/stray\.txt.*outside the bundle's root folder/i);
  });

  it("warns when files exist for a category not in includedCategories", () => {
    const zip = bundleOf(
      [
        {
          path: "committee/roles.csv",
          category: "committee",
          rowCount: 0,
          bytes: strToU8("key,name,description,contactEmail,isActive,sortOrder\n"),
        },
      ],
      // Manifest deliberately omits "committee" from includedCategories.
      [],
    );
    const { warnings } = readBundle(zip);
    expect(warnings.join(" ")).toMatch(/category "committee".*NOT be imported/i);
  });

  it("reseal recomputes doorCodesIncluded from the actual files", () => {
    const zip = lodgeBundle({
      lodgeJson: { slug: "main", name: "Main Lodge", active: true, doorCode: "4271", isDefault: false },
    });
    // Exported with doorCodesIncluded=false (bundleOf default) but a door code
    // hand-added: reseal must flip the flag to true.
    const resealed = readBundle(resealBundle(zip));
    expect(resealed.manifest.doorCodesIncluded).toBe(true);
  });
});

describe("media plan validation", () => {
  it("errors on an oversized image and a malformed media map", async () => {
    const bigImage = new Uint8Array(2 * 1024 * 1024 + 1);
    // PNG magic bytes so the sniffer accepts the type; the size cap still fires.
    bigImage.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const zip = bundleOf(
      [
        {
          path: "site-content/pages.csv",
          category: "site-content",
          rowCount: 0,
          bytes: strToU8("slug,path,caption,menuTitle,title,headerText,sortOrder,contentHtml,published\n"),
        },
        { path: "media/img1.png", category: "site-content", rowCount: null, bytes: bigImage },
        {
          path: "media/media-map.json",
          category: "site-content",
          rowCount: 1,
          bytes: strToU8(JSON.stringify({ old1: { path: "media/img1.png", filename: "big.png", contentType: "image/png" } })),
        },
      ],
      ["site-content"],
    );
    const db = {
      pageContent: { findMany: vi.fn().mockResolvedValue([]) },
      siteContent: { findMany: vi.fn().mockResolvedValue([]) },
      clubTheme: { findUnique: vi.fn().mockResolvedValue(null) },
      mediaImage: { findMany: vi.fn().mockResolvedValue([]) },
      xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as ReadDb;
    const plan = await buildImportPlan(db, zip, { mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(/over the .*image limit/i);

    // Malformed media-map: a trailing comma is a plan-time ERROR, not an
    // apply-time crash after the backup.
    const badMap = bundleOf(
      [
        {
          path: "site-content/pages.csv",
          category: "site-content",
          rowCount: 0,
          bytes: strToU8("slug,path,caption,menuTitle,title,headerText,sortOrder,contentHtml,published\n"),
        },
        { path: "media/media-map.json", category: "site-content", rowCount: 1, bytes: strToU8('{"a":,}') },
      ],
      ["site-content"],
    );
    const plan2 = await buildImportPlan(db, badMap, { mode: "merge" });
    expect(plan2.errors.join(" ")).toMatch(/media-map\.json is not valid JSON/i);
  });
});

describe("import-side category selection", () => {
  it("plans only the selected categories and binds the selection", async () => {
    const zip = bundleOf(
      [
        {
          path: "committee/roles.csv",
          category: "committee",
          rowCount: 1,
          bytes: strToU8("key,name,description,contactEmail,isActive,sortOrder\npresident,President,,,true,1\n"),
        },
        {
          path: "xero-config/account-mappings.csv",
          category: "xero-config",
          rowCount: 1,
          bytes: strToU8("key,code,itemCode\nhutFeesIncome,200,\n"),
        },
      ],
      ["committee", "xero-config"],
    );
    const db = () =>
      ({
        committeeRole: { findMany: vi.fn().mockResolvedValue([]) },
        xeroAccountMapping: { findMany: vi.fn().mockResolvedValue([]) },
        xeroItemCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
        xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
      }) as unknown as ReadDb;

    const all = await buildImportPlan(db(), zip, { mode: "merge" });
    expect(all.selectedCategories).toEqual(["committee", "xero-config"]);

    const committeeOnly = await buildImportPlan(db(), zip, {
      mode: "merge",
      selectedCategories: ["committee"],
    });
    expect(committeeOnly.selectedCategories).toEqual(["committee"]);
    expect(committeeOnly.categories.map((c) => c.category)).toEqual(["committee"]);
    // Selection is fingerprint-bound: deselecting a category → different print.
    expect(committeeOnly.fingerprint).not.toBe(all.fingerprint);
  });
});
