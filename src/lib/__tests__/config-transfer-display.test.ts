import { describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

vi.mock("server-only", () => ({}));

import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import { displayImporter } from "@/lib/config-transfer/categories/display";
import { readBundle } from "@/lib/config-transfer/bundle";
import type { ReadDb, TxDb } from "@/lib/config-transfer/import-types";

// LTV-037: config-transfer for the v2 club-wide Layout/Template library. These
// entities ride in the lodge-config category (files display/layouts.json +
// display/templates.json). The suite exercises the round-trip, the
// canonicalValue Json diff, the save-contract plan errors, and layout-before-
// template apply ordering.

const LAYOUTS_FILE = "display/layouts.json";
const TEMPLATES_FILE = "display/templates.json";

// One clean full-width board layout + one rotator layout, mirroring the seed.
const BOARD_LAYOUT = {
  key: "room-occupancy",
  name: "Room occupancy board",
  description: "Full-width arrivals board.",
  bodyHtml: '<div class="board">{{area:main}}</div>',
  defaultCss: ".board { width: 100%; }",
  areas: [{ key: "main", description: "The arrivals board", kind: "static" }],
};
const ROTATE_LAYOUT = {
  key: "room-occupancy-rotating",
  name: "Room occupancy + notice (rotating)",
  description: "Board and committee notice, rotating.",
  bodyHtml: '<div class="board">{{area:main}}</div>',
  defaultCss: ".board { width: 100%; }",
  areas: [
    {
      key: "main",
      description: "Rotating board and notice",
      kind: "rotator",
      rotateSeconds: 12,
      children: [
        { key: "board", description: "Arrivals board" },
        { key: "notice", description: "Committee notice", condition: "content:notice" },
      ],
    },
  ],
};
const TEMPLATES = [
  {
    key: "room-occupancy-3day",
    name: "Room occupancy — 3 day",
    layoutKey: "room-occupancy",
    slotContent: { main: { module: "arrivals-board", options: { days: 3 } } },
    cssOverrides: "",
    footerHtml: "",
  },
  {
    key: "room-occupancy-week",
    name: "Room occupancy — week",
    layoutKey: "room-occupancy",
    slotContent: { main: { module: "arrivals-board", options: { days: 7 } } },
    cssOverrides: "",
    footerHtml: "",
  },
  {
    key: "occupancy-rotating",
    name: "Occupancy + notices",
    layoutKey: "room-occupancy-rotating",
    slotContent: {
      "main/board": { module: "arrivals-board", options: { days: 3 } },
      "main/notice": { module: "notice-board" },
    },
    cssOverrides: "",
    footerHtml: "",
  },
];

/** Source DB carrying ONLY display rows (no lodges) — the seed shape. */
function sourceDb(): ReadDb {
  return {
    lodge: { findMany: vi.fn().mockResolvedValue([]) },
    lodgeRoom: { findMany: vi.fn().mockResolvedValue([]) },
    lodgeBed: { findMany: vi.fn().mockResolvedValue([]) },
    season: { findMany: vi.fn().mockResolvedValue([]) },
    seasonRate: { findMany: vi.fn().mockResolvedValue([]) },
    lodgeInstruction: { findMany: vi.fn().mockResolvedValue([]) },
    choreTemplate: { findMany: vi.fn().mockResolvedValue([]) },
    displayLayout: {
      findMany: vi.fn().mockResolvedValue([BOARD_LAYOUT, ROTATE_LAYOUT]),
    },
    displayTemplate: {
      findMany: vi.fn().mockResolvedValue(
        TEMPLATES.map((t) => ({
          key: t.key,
          name: t.name,
          slotContent: t.slotContent,
          cssOverrides: t.cssOverrides,
          footerHtml: t.footerHtml,
          layout: { key: t.layoutKey },
        })),
      ),
    },
  } as unknown as ReadDb;
}

/** Empty target — every lodge-config importer's read models present. */
function emptyTargetDb(overrides: Record<string, unknown> = {}): ReadDb {
  return {
    lodge: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    lodgeRoom: { findMany: vi.fn().mockResolvedValue([]) },
    lodgeBed: { findMany: vi.fn().mockResolvedValue([]) },
    season: { findMany: vi.fn().mockResolvedValue([]) },
    seasonRate: { findMany: vi.fn().mockResolvedValue([]) },
    lodgeInstruction: { findMany: vi.fn().mockResolvedValue([]) },
    choreTemplate: { findMany: vi.fn().mockResolvedValue([]) },
    displayLayout: { findMany: vi.fn().mockResolvedValue([]) },
    displayTemplate: { findMany: vi.fn().mockResolvedValue([]) },
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
    ...overrides,
  } as unknown as ReadDb;
}

async function exportBundle() {
  const { zip } = await buildConfigExport({
    db: sourceDb(),
    categories: ["lodge-config"],
    includeDoorCodes: false,
    appVersion: "0.10.1",
    prismaMigration: null,
    generatedAt: "2026-07-12T00:00:00.000Z",
  });
  return zip;
}

function readJsonFile(files: Map<string, Uint8Array>, path: string): unknown[] {
  return JSON.parse(strFromU8(files.get(path)!)) as unknown[];
}

/** Rewrite one file inside an exported bundle (integrity is warn-only). */
function withFile(zip: Uint8Array, path: string, value: unknown): Uint8Array {
  const unzipped = unzipSync(zip);
  unzipped[path] = strToU8(JSON.stringify(value));
  return zipSync(unzipped);
}

describe("config-transfer display — export shape", () => {
  it("serialises layouts and templates in the v2 shape (template by layoutKey, no id)", async () => {
    const { files } = readBundle(await exportBundle());

    const layouts = readJsonFile(files, LAYOUTS_FILE) as Record<string, unknown>[];
    expect(layouts.map((l) => l.key)).toEqual(["room-occupancy", "room-occupancy-rotating"]);
    expect(layouts[0]).toMatchObject({ name: "Room occupancy board", areas: expect.any(Array) });

    const templates = readJsonFile(files, TEMPLATES_FILE) as Record<string, unknown>[];
    expect(templates.map((t) => t.key)).toEqual([
      "room-occupancy-3day",
      "room-occupancy-week",
      "occupancy-rotating",
    ]);
    // Bound by LAYOUT KEY, never a database id.
    expect(templates[0].layoutKey).toBe("room-occupancy");
    expect("layoutId" in templates[0]).toBe(false);
    expect("id" in templates[0]).toBe(false);
  });
});

describe("config-transfer display — plan (round-trip + diff)", () => {
  it("plans all-create against an empty target with no errors", async () => {
    const plan = await buildImportPlan(emptyTargetDb(), await exportBundle(), { mode: "merge" });
    const cat = plan.categories.find((c) => c.category === "lodge-config")!;
    expect(cat.errors).toEqual([]);
    const layouts = cat.items.filter((i) => i.entity === "display-layout");
    const templates = cat.items.filter((i) => i.entity === "display-template");
    expect(layouts.map((i) => i.key)).toEqual(["room-occupancy", "room-occupancy-rotating"]);
    expect(layouts.every((i) => i.action === "create")).toBe(true);
    expect(templates.map((i) => i.key)).toEqual([
      "room-occupancy-3day",
      "room-occupancy-week",
      "occupancy-rotating",
    ]);
    expect(templates.every((i) => i.action === "create")).toBe(true);
  });

  it("plans a no-op when the target already holds identical rows (Json key order ignored)", async () => {
    const zip = await exportBundle();
    // Target mirrors the source, but with Json object keys in a DIFFERENT order
    // (options before module, areas child fields reordered) — canonicalValue must
    // treat these as unchanged.
    const target = emptyTargetDb({
      displayLayout: {
        findMany: vi.fn().mockResolvedValue([
          { id: "L1", ...BOARD_LAYOUT },
          {
            id: "L2",
            ...ROTATE_LAYOUT,
            areas: [
              {
                description: "Rotating board and notice",
                kind: "rotator",
                key: "main",
                rotateSeconds: 12,
                children: [
                  { description: "Arrivals board", key: "board" },
                  { condition: "content:notice", description: "Committee notice", key: "notice" },
                ],
              },
            ],
          },
        ]),
      },
      displayTemplate: {
        findMany: vi.fn().mockResolvedValue(
          TEMPLATES.map((t, i) => ({
            id: `T${i}`,
            key: t.key,
            name: t.name,
            slotContent: reorderSlotContent(t.slotContent),
            cssOverrides: t.cssOverrides,
            footerHtml: t.footerHtml,
            layout: { key: t.layoutKey, bodyHtml: layoutBody(t.layoutKey), areas: layoutAreas(t.layoutKey) },
          })),
        ),
      },
    });
    const plan = await buildImportPlan(target, zip, { mode: "merge" });
    const cat = plan.categories.find((c) => c.category === "lodge-config")!;
    const display = cat.items.filter(
      (i) => i.entity === "display-layout" || i.entity === "display-template",
    );
    expect(display.length).toBe(5);
    expect(display.every((i) => i.action === "unchanged")).toBe(true);
  });

  it("shows a field diff when a template's slotContent changes", async () => {
    const zip = await exportBundle();
    const target = emptyTargetDb({
      displayLayout: {
        findMany: vi.fn().mockResolvedValue([
          { id: "L1", ...BOARD_LAYOUT },
          { id: "L2", ...ROTATE_LAYOUT },
        ]),
      },
      displayTemplate: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "T0",
            key: "room-occupancy-3day",
            name: "Room occupancy — 3 day",
            // Different option value → a slotContent diff.
            slotContent: { main: { module: "arrivals-board", options: { days: 5 } } },
            cssOverrides: "",
            footerHtml: "",
            layout: { key: "room-occupancy", bodyHtml: BOARD_LAYOUT.bodyHtml, areas: BOARD_LAYOUT.areas },
          },
        ]),
      },
    });
    const plan = await buildImportPlan(target, zip, { mode: "overwrite" });
    const cat = plan.categories.find((c) => c.category === "lodge-config")!;
    const item = cat.items.find((i) => i.entity === "display-template" && i.key === "room-occupancy-3day")!;
    expect(item.action).toBe("update");
    expect(item.changedFields).toContain("slotContent");
  });
});

describe("config-transfer display — plan errors (save contract)", () => {
  it("blocks an invalid layout (bodyHtml references an undeclared area)", async () => {
    const zip = withFile(await exportBundle(), LAYOUTS_FILE, [
      { ...BOARD_LAYOUT, areas: [] }, // {{area:main}} now has no matching entry
    ]);
    const plan = await buildImportPlan(emptyTargetDb(), zip, { mode: "merge" });
    const cat = plan.categories.find((c) => c.category === "lodge-config")!;
    expect(cat.errors.join("\n")).toMatch(/layout "room-occupancy"[\s\S]*area "main"/i);
  });

  it("blocks a template whose layoutKey is in neither the bundle nor the DB", async () => {
    const zip = withFile(await exportBundle(), TEMPLATES_FILE, [
      { ...TEMPLATES[0], layoutKey: "no-such-layout" },
    ]);
    const plan = await buildImportPlan(emptyTargetDb(), zip, { mode: "merge" });
    const cat = plan.categories.find((c) => c.category === "lodge-config")!;
    expect(cat.errors.join("\n")).toMatch(/layoutKey "no-such-layout" is in neither/i);
  });

  it("blocks a template that fails validateTemplateForSave (unknown slot key)", async () => {
    const zip = withFile(await exportBundle(), TEMPLATES_FILE, [
      {
        ...TEMPLATES[0],
        slotContent: { "does-not-exist": { module: "arrivals-board" } },
      },
    ]);
    const plan = await buildImportPlan(emptyTargetDb(), zip, { mode: "merge" });
    const cat = plan.categories.find((c) => c.category === "lodge-config")!;
    expect(cat.errors.join("\n")).toMatch(/unknown slot key "does-not-exist"/i);
  });
});

describe("config-transfer display — apply", () => {
  it("upserts by key and applies layouts BEFORE templates, binding to the new layout id", async () => {
    const { files } = readBundle(await exportBundle());
    const order: string[] = [];
    const createdTemplates: Array<{ key: string; layoutId: string }> = [];
    const tx = {
      displayLayout: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockImplementation(({ data }) => {
          order.push(`layout:${data.key}`);
          return Promise.resolve({ id: `newid-${data.key}` });
        }),
        update: vi.fn(),
      },
      displayTemplate: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockImplementation(({ data }) => {
          order.push(`template:${data.key}`);
          createdTemplates.push({ key: data.key, layoutId: data.layoutId });
          return Promise.resolve({ id: `newt-${data.key}` });
        }),
        update: vi.fn(),
      },
    } as unknown as TxDb;

    const result = await displayImporter.apply({
      tx,
      files,
      manifest: {} as never,
      mode: "merge",
      resolutions: new Map(),
      actorMemberId: "admin-1",
      imageRemap: new Map(),
      notes: { doorCodesWritten: [] },
    });

    expect(result.created).toBe(5); // 2 layouts + 3 templates
    // Both layouts precede every template.
    const firstTemplateIdx = order.findIndex((o) => o.startsWith("template:"));
    const lastLayoutIdx = order.map((o) => o.startsWith("layout:")).lastIndexOf(true);
    expect(lastLayoutIdx).toBeLessThan(firstTemplateIdx);
    // Templates bound to the freshly-created layout ids (layoutKey → new id).
    expect(createdTemplates).toContainEqual({
      key: "room-occupancy-3day",
      layoutId: "newid-room-occupancy",
    });
    expect(createdTemplates).toContainEqual({
      key: "occupancy-rotating",
      layoutId: "newid-room-occupancy-rotating",
    });
  });
});

// --- helpers shared by the no-op test -------------------------------------
function layoutBody(key: string): string {
  return key === "room-occupancy" ? BOARD_LAYOUT.bodyHtml : ROTATE_LAYOUT.bodyHtml;
}
function layoutAreas(key: string): unknown {
  return key === "room-occupancy" ? BOARD_LAYOUT.areas : ROTATE_LAYOUT.areas;
}
/** Reorder object keys inside slotContent so the Json diff is exercised. */
function reorderSlotContent(slot: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(slot)) {
    if (v && typeof v === "object" && "module" in (v as object)) {
      const rec = v as Record<string, unknown>;
      out[k] = rec.options !== undefined
        ? { options: rec.options, module: rec.module }
        : { module: rec.module };
    } else {
      out[k] = v;
    }
  }
  return out;
}
