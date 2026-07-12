import { strToU8, strFromU8 } from "fflate";
import type { Prisma } from "@prisma/client";

import {
  validateLayoutForSave,
  validateTemplateForSave,
} from "@/lib/lodge-display/authoring-validation";
import type { BundleEntry } from "../bundle";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  changedFields,
  hashRow,
  planActionFor,
  updateDataForMode,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
  type ReadDb,
} from "../import-types";
import { asStr } from "../values";

// lodge-config category (part 3): the CLUB-WIDE v2 lobby-display Layout and
// Template library (ADR-003 §1, LTV-024/037). Rebuilds the config-transfer
// surface the retired MVP DisplayTemplate model used to occupy (LTV-012), now
// expressed as the two v2 entities:
//
//   display/layouts.json    [ { key, name, description, bodyHtml, defaultCss, areas } ]
//   display/templates.json  [ { key, name, layoutKey, slotContent, cssOverrides, footerHtml } ]
//
// Placement (why lodge-config, not a new category): the per-lodge display
// FIELDS already travel in lodge-config (lodge.json's displayConfig /
// displayNameGranularity / displayNotice), and lodge-ops already proves a
// club-wide file (lodge-config/instructions.csv) can live in this category
// alongside the per-lodge folders. Shipping the club-wide Layout/Template
// library here means selecting "Lodge configuration" yields a self-consistent
// display setup — an operator can never carry the lodge's display settings
// without the layouts/templates they reference. Both entities are club-wide
// (not per-lodge), so they are top-level `display/*` files, not lodge folders.
//
// Identity is key-strong (match on `key`, never id): template bindings and
// device pairings key off these slugs, so a bundle upserts by key.
//
// Validation mirrors the SAVE path exactly (ADR-003 §5 "Unattended surface"): a
// lobby wall is unattended, so a Layout/Template is proven safe BEFORE it is
// persisted. The import runs the very same `validateLayoutForSave` /
// `validateTemplateForSave` contract the authoring routes call — an invalid
// layout or a template that fails its slot check is a PLAN-BLOCKING error, so a
// bundle can never install a broken display. layoutKey is resolved to a real
// layoutId at apply (a template whose layoutKey is in neither the bundle nor the
// target DB is a plan error). Layouts always apply BEFORE templates so a
// template can bind a layout the same bundle creates.

const LAYOUTS_FILE = "display/layouts.json";
const TEMPLATES_FILE = "display/templates.json";

const LAYOUT_FIELDS = ["key", "name", "description", "bodyHtml", "defaultCss", "areas"] as const;
const TEMPLATE_FIELDS = ["key", "name", "layoutKey", "slotContent", "cssOverrides", "footerHtml"] as const;

// Fields hashed into the drift fingerprint (identity `key` excluded). Both sides
// (preview + in-lock re-plan) hash the SAME DB rows, so hashRow's plain
// stringify is stable here; the bundle-vs-current DIFF uses canonicalValue
// (order-independent) via changedFields, which is what matters for Json columns.
const LAYOUT_HASH_FIELDS = ["name", "description", "bodyHtml", "defaultCss", "areas"];
const TEMPLATE_HASH_FIELDS = ["name", "layoutKey", "slotContent", "cssOverrides", "footerHtml"];

// Slug shape shared with the authoring routes (lower-case, ≤80 chars).
const KEY_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const KEY_MAX = 80;
const NAME_MAX = 120;

registerEntity({
  entity: "display-layout",
  category: "lodge-config",
  tier: "key-strong",
  format: "json",
  file: LAYOUTS_FILE,
  naturalKey: ["key"],
  singleton: false,
  fields: [...LAYOUT_FIELDS],
});
registerEntity({
  entity: "display-template",
  category: "lodge-config",
  tier: "key-strong",
  format: "json",
  file: TEMPLATES_FILE,
  naturalKey: ["key"],
  singleton: false,
  fields: [...TEMPLATE_FIELDS],
});

function asNullableStr(value: unknown): string | null {
  const s = asStr(value);
  return s === "" ? null : s;
}

/** Parse one `display/*.json` collection file into loose row records. A present
 * but malformed file (bad JSON, or not a top-level array) is an error, not a
 * silent empty — an operator's broken hand-edit must block, never disappear. An
 * absent file yields []. */
function parseJsonCollection(
  files: Map<string, Uint8Array>,
  path: string,
  errors: string[],
): Record<string, unknown>[] {
  const bytes = files.get(path);
  if (bytes === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(strFromU8(bytes));
  } catch {
    errors.push(`${path}: not valid JSON`);
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be a JSON array of objects`);
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const [i, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${path}[${i}]: each entry must be an object`);
      continue;
    }
    rows.push(entry as Record<string, unknown>);
  }
  return rows;
}

/** The layout write-data (allowlisted fields, coerced) built from a bundle row. */
function buildLayoutData(raw: Record<string, unknown>) {
  return {
    name: asStr(raw.name),
    description: asNullableStr(raw.description),
    // Left uncoerced so the save contract can report a precise "bodyHtml must be
    // a string" / "areas must be an array" error rather than silently accepting
    // a nonsense empty layout.
    bodyHtml: typeof raw.bodyHtml === "string" ? raw.bodyHtml : raw.bodyHtml,
    defaultCss: typeof raw.defaultCss === "string" ? raw.defaultCss : raw.defaultCss,
    areas: raw.areas,
  };
}

/** The template write-data (allowlisted fields, coerced) built from a bundle row.
 * Carries layoutKey for the diff; apply resolves it to a layoutId. */
function buildTemplateData(raw: Record<string, unknown>) {
  return {
    name: asStr(raw.name),
    layoutKey: asStr(raw.layoutKey),
    slotContent: raw.slotContent,
    cssOverrides: typeof raw.cssOverrides === "string" ? raw.cssOverrides : raw.cssOverrides,
    footerHtml: typeof raw.footerHtml === "string" ? raw.footerHtml : raw.footerHtml,
  };
}

// ---- Export ----------------------------------------------------------------

export const displayExporter: CategoryExporter = {
  category: "lodge-config",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const layouts = await ctx.db.displayLayout.findMany({
      orderBy: { key: "asc" },
      select: {
        key: true, name: true, description: true,
        bodyHtml: true, defaultCss: true, areas: true,
      },
    });
    const templates = await ctx.db.displayTemplate.findMany({
      orderBy: { key: "asc" },
      select: {
        key: true, name: true, slotContent: true, cssOverrides: true,
        footerHtml: true, layout: { select: { key: true } },
      },
    });

    // Stored values are serialised as authored/typed. Any CSS the serve-time
    // sanitiser would neutralise is NOT re-raised here (export is not a save):
    // serve time re-sanitises identically, and re-import runs the save contract
    // again, so a warning belongs at authoring/import, not at export.
    const layoutRows = layouts.map((l) => ({
      key: l.key,
      name: l.name,
      description: l.description,
      bodyHtml: l.bodyHtml,
      defaultCss: l.defaultCss,
      areas: l.areas,
    }));
    const templateRows = templates.map((t) => ({
      key: t.key,
      name: t.name,
      // Serialised by LAYOUT KEY (never id) — the id is not portable.
      layoutKey: t.layout.key,
      slotContent: t.slotContent,
      cssOverrides: t.cssOverrides,
      footerHtml: t.footerHtml,
    }));

    // Always emit both files (header-only when empty) whenever lodge-config is
    // exported, so the display library travels as a unit and the format is
    // self-documenting for hand-authoring from scratch.
    return [
      {
        path: LAYOUTS_FILE,
        category: "lodge-config",
        rowCount: layoutRows.length,
        bytes: strToU8(JSON.stringify(layoutRows, null, 2)),
      },
      {
        path: TEMPLATES_FILE,
        category: "lodge-config",
        rowCount: templateRows.length,
        bytes: strToU8(JSON.stringify(templateRows, null, 2)),
      },
    ];
  },
};

// ---- Current-state loading (shared by plan + apply) ------------------------

interface LayoutCurrent {
  id: string;
  key: string;
  name: string;
  description: string | null;
  bodyHtml: string;
  defaultCss: string;
  areas: unknown;
}
interface TemplateCurrent {
  id: string;
  key: string;
  name: string;
  slotContent: unknown;
  cssOverrides: string;
  footerHtml: string;
  layout: { key: string; bodyHtml: string; areas: unknown };
}

async function loadLayouts(db: ReadDb): Promise<LayoutCurrent[]> {
  return db.displayLayout.findMany({
    select: {
      id: true, key: true, name: true, description: true,
      bodyHtml: true, defaultCss: true, areas: true,
    },
  });
}
async function loadTemplates(db: ReadDb): Promise<TemplateCurrent[]> {
  return db.displayTemplate.findMany({
    select: {
      id: true, key: true, name: true, slotContent: true,
      cssOverrides: true, footerHtml: true,
      layout: { select: { key: true, bodyHtml: true, areas: true } },
    },
  });
}

/** Project a current template row into the diff shape (layout referenced by
 * key, matching the bundle's allowlisted field names). */
function templateForDiff(t: TemplateCurrent) {
  return {
    name: t.name,
    layoutKey: t.layout.key,
    slotContent: t.slotContent,
    cssOverrides: t.cssOverrides,
    footerHtml: t.footerHtml,
  };
}

/** Basic structural gate mirroring the authoring routes' zod checks (key slug,
 * name present) — the deep save contract runs after. Returns true when the row
 * may proceed; pushes errors and returns false otherwise. */
function checkKeyAndName(
  raw: Record<string, unknown>,
  where: string,
  seen: Set<string>,
  errors: string[],
): string | null {
  const key = asStr(raw.key).trim();
  if (!key) {
    errors.push(`${where}: a row is missing its "key"`);
    return null;
  }
  if (!KEY_SLUG.test(key) || key.length > KEY_MAX) {
    errors.push(`${where}: key "${key}" must be a lower-case slug (a-z, 0-9, -), max ${KEY_MAX} chars`);
    return null;
  }
  if (seen.has(key)) {
    errors.push(`${where}: duplicate key "${key}"`);
    return null;
  }
  seen.add(key);
  const name = asStr(raw.name).trim();
  if (!name || name.length > NAME_MAX) {
    errors.push(`${where} "${key}": name is required and must be at most ${NAME_MAX} characters`);
  }
  return key;
}

// ---- Plan ------------------------------------------------------------------

async function planDisplay(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];

  const bundleLayouts = parseJsonCollection(ctx.files, LAYOUTS_FILE, errors);
  const bundleTemplates = parseJsonCollection(ctx.files, TEMPLATES_FILE, errors);
  // No display rows in the bundle → nothing to plan; skip the display tables
  // entirely so unrelated lodge-config imports never touch them.
  if (bundleLayouts.length === 0 && bundleTemplates.length === 0) {
    return { items, warnings, errors, fingerprintParts };
  }

  const [currentLayouts, currentTemplates] = await Promise.all([
    loadLayouts(ctx.db),
    loadTemplates(ctx.db),
  ]);
  const currentLayoutByKey = new Map(currentLayouts.map((l) => [l.key, l]));
  const currentTemplateByKey = new Map(currentTemplates.map((t) => [t.key, t]));

  // Layout definitions a template may validate against: bundle layouts win over
  // the DB (a bundle can update the layout a template also retargets in the same
  // apply). Only VALID layouts enter this map — a template must never be judged
  // against a layout the bundle failed to install.
  const layoutDefByKey = new Map<string, { bodyHtml: string; areas: unknown }>();
  for (const l of currentLayouts) {
    layoutDefByKey.set(l.key, { bodyHtml: l.bodyHtml, areas: l.areas });
  }

  // --- Layouts (apply before templates) ---
  const seenLayoutKeys = new Set<string>();
  for (const raw of bundleLayouts) {
    const key = checkKeyAndName(raw, LAYOUTS_FILE, seenLayoutKeys, errors);
    if (!key) continue;
    const data = buildLayoutData(raw);
    // Save-contract validation — an invalid layout blocks the plan, exactly like
    // the save path refuses it. Structural errors fail; CSS-sanitiser findings
    // are warnings (serve time re-sanitises, so the wall is safe).
    const verdict = validateLayoutForSave({
      bodyHtml: data.bodyHtml as string,
      defaultCss: (data.defaultCss as string) ?? "",
      areas: data.areas,
    });
    for (const w of verdict.warnings) {
      warnings.push(`Layout "${key}" ${w.path}: ${w.message}`);
    }
    if (!verdict.ok) {
      for (const e of verdict.errors) {
        errors.push(`${LAYOUTS_FILE} layout "${key}": ${e.path} — ${e.message}`);
      }
      continue;
    }
    layoutDefByKey.set(key, { bodyHtml: data.bodyHtml as string, areas: data.areas });

    const current = currentLayoutByKey.get(key) ?? null;
    fingerprintParts.push(
      `display-layout:${key}:${current ? hashRow(LAYOUT_HASH_FIELDS, current) : "absent"}`,
    );
    const write = updateDataForMode(ctx.mode, raw, data);
    const changed = changedFields(write, current);
    items.push({
      entity: "display-layout",
      key,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }

  // --- Templates ---
  const seenTemplateKeys = new Set<string>();
  for (const raw of bundleTemplates) {
    const key = checkKeyAndName(raw, TEMPLATES_FILE, seenTemplateKeys, errors);
    if (!key) continue;
    const layoutKey = asStr(raw.layoutKey).trim();
    if (!layoutKey) {
      errors.push(`${TEMPLATES_FILE} template "${key}": missing "layoutKey"`);
      continue;
    }
    const layoutDef = layoutDefByKey.get(layoutKey);
    if (!layoutDef) {
      errors.push(
        `${TEMPLATES_FILE} template "${key}": layoutKey "${layoutKey}" is in neither ` +
          `the bundle nor the target database`,
      );
      continue;
    }
    const data = buildTemplateData(raw);
    const verdict = validateTemplateForSave({
      layout: { bodyHtml: layoutDef.bodyHtml, areas: layoutDef.areas },
      slotContent: data.slotContent,
      cssOverrides: (data.cssOverrides as string) ?? "",
      footerHtml: (data.footerHtml as string) ?? "",
    });
    for (const w of verdict.warnings) {
      warnings.push(`Template "${key}" ${w.path}: ${w.message}`);
    }
    if (!verdict.ok) {
      for (const e of verdict.errors) {
        errors.push(`${TEMPLATES_FILE} template "${key}": ${e.path} — ${e.message}`);
      }
      continue;
    }

    const current = currentTemplateByKey.get(key) ?? null;
    const currentForDiff = current ? templateForDiff(current) : null;
    fingerprintParts.push(
      `display-template:${key}:${current ? hashRow(TEMPLATE_HASH_FIELDS, currentForDiff!) : "absent"}`,
    );
    const write = updateDataForMode(ctx.mode, raw, data);
    const changed = changedFields(write, currentForDiff);
    items.push({
      entity: "display-template",
      key,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }

  return { items, warnings, errors, fingerprintParts };
}

// ---- Apply -----------------------------------------------------------------

async function applyDisplay(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive only

  const bundleLayouts = parseJsonCollection(ctx.files, LAYOUTS_FILE, errors);
  const bundleTemplates = parseJsonCollection(ctx.files, TEMPLATES_FILE, errors);
  if (bundleLayouts.length === 0 && bundleTemplates.length === 0) return result;

  // 1) Layouts FIRST — upsert by key; keep key→id so templates can bind a layout
  //    this same apply just created.
  const currentLayouts = await loadLayouts(ctx.tx);
  const layoutByKey = new Map(currentLayouts.map((l) => [l.key, l]));
  const layoutIdByKey = new Map(currentLayouts.map((l) => [l.key, l.id]));

  const seenLayoutKeys = new Set<string>();
  for (const raw of bundleLayouts) {
    const key = asStr(raw.key).trim();
    if (!key || seenLayoutKeys.has(key)) {
      result.skipped += 1;
      continue;
    }
    seenLayoutKeys.add(key);
    const data = buildLayoutData(raw);
    const current = layoutByKey.get(key) ?? null;
    if (!current) {
      const created = await ctx.tx.displayLayout.create({
        data: {
          key,
          name: data.name,
          description: data.description,
          bodyHtml: data.bodyHtml as string,
          defaultCss: data.defaultCss as string,
          areas: data.areas as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      layoutIdByKey.set(key, created.id);
      result.created += 1;
    } else {
      const write = updateDataForMode(ctx.mode, raw, data);
      const changed = changedFields(write, current);
      if (changed.length === 0) {
        result.unchanged += 1;
        continue;
      }
      const update: Prisma.DisplayLayoutUpdateInput = {};
      if ("name" in write) update.name = write.name as string;
      if ("description" in write) update.description = write.description as string | null;
      if ("bodyHtml" in write) update.bodyHtml = write.bodyHtml as string;
      if ("defaultCss" in write) update.defaultCss = write.defaultCss as string;
      if ("areas" in write) update.areas = write.areas as Prisma.InputJsonValue;
      await ctx.tx.displayLayout.update({ where: { id: current.id }, data: update });
      result.updated += 1;
    }
  }

  // 2) Templates — resolve layoutKey→id (bundle-created + existing), upsert by key.
  const currentTemplates = await loadTemplates(ctx.tx);
  const templateByKey = new Map(currentTemplates.map((t) => [t.key, t]));

  const seenTemplateKeys = new Set<string>();
  for (const raw of bundleTemplates) {
    const key = asStr(raw.key).trim();
    if (!key || seenTemplateKeys.has(key)) {
      result.skipped += 1;
      continue;
    }
    seenTemplateKeys.add(key);
    const layoutKey = asStr(raw.layoutKey).trim();
    const layoutId = layoutIdByKey.get(layoutKey);
    if (!layoutId) {
      result.skipped += 1; // plan blocked an unresolved layoutKey; defensive
      continue;
    }
    const data = buildTemplateData(raw);
    const current = templateByKey.get(key) ?? null;
    if (!current) {
      await ctx.tx.displayTemplate.create({
        data: {
          key,
          name: data.name,
          layoutId,
          slotContent: data.slotContent as Prisma.InputJsonValue,
          cssOverrides: data.cssOverrides as string,
          footerHtml: data.footerHtml as string,
        },
      });
      result.created += 1;
    } else {
      const write = updateDataForMode(ctx.mode, raw, data);
      const changed = changedFields(write, templateForDiff(current));
      if (changed.length === 0) {
        result.unchanged += 1;
        continue;
      }
      const update: Prisma.DisplayTemplateUpdateInput = {};
      if ("name" in write) update.name = write.name as string;
      // A changed layoutKey rebinds to the resolved layoutId.
      if ("layoutKey" in write) update.layout = { connect: { id: layoutId } };
      if ("slotContent" in write) update.slotContent = write.slotContent as Prisma.InputJsonValue;
      if ("cssOverrides" in write) update.cssOverrides = write.cssOverrides as string;
      if ("footerHtml" in write) update.footerHtml = write.footerHtml as string;
      await ctx.tx.displayTemplate.update({ where: { id: current.id }, data: update });
      result.updated += 1;
    }
  }

  return result;
}

export const displayImporter: CategoryImporter = {
  category: "lodge-config",
  plan: planDisplay,
  apply: applyDisplay,
};
