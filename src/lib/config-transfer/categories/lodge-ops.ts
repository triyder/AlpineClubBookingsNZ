import { strToU8, strFromU8 } from "fflate";

import { sanitizePageContentHtml } from "@/lib/page-content-html";
import type { BundleEntry } from "../bundle";
import { serialiseCsv, parseCsv } from "../csv";
import { registerEntity } from "../registry";
import { remapImageRefs } from "../media";
import type { CategoryExporter, ExportContext } from "../export-types";
import { extractImageIds } from "./site-content";
import {
  LODGES_PREFIX,
  folderLodgeSlug,
  lodgeFolderFiles,
  lodgeFolderSegments,
} from "./lodge-config";
import {
  hashRow,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  updateDataForMode,
  type PlanContext,
  type PlanItem,
  type ReadDb,
  type TxDb,
} from "../import-types";

// lodge-config category (part 2): lodge instructions and chore templates, laid
// out to match the per-lodge folders from lodge-config (part 1):
//   lodge-config/lodges/<slug>/instructions.csv     key, contentHtml
//   lodge-config/lodges/<slug>/chore-templates.csv  name, description, ...
//   lodge-config/instructions.csv                   key, contentHtml  ← club-wide
// Instructions may be club-wide (lodgeId null) — those live in the top-level
// file, not a lodge folder. Chore templates are always lodge-scoped. Instruction
// content may embed images (remapped on apply).
//
// Booking/cancellation/min-stay policies are intentionally deferred — their
// replace-the-whole-tier-set semantics conflict with the upsert-only model and
// touch refund maths, so getting them subtly wrong is unsafe. See ADR-001/002.

/** Club-wide (lodgeId null) instructions live here, outside any lodge folder. */
const CLUB_INSTRUCTION_FILE = "lodge-config/instructions.csv";

const INSTRUCTION_FIELDS = ["key", "contentHtml"] as const;
const CHORE_FIELDS = [
  "name", "description", "recommendedPeopleMin",
  "recommendedPeopleMax", "isEssential", "ageRestriction", "conditionalNote",
  "minAge", "sortOrder", "timeOfDay", "frequencyMode", "frequencyDays", "active",
] as const;

registerEntity({
  entity: "lodge-instruction",
  category: "lodge-config",
  tier: "key-weak",
  format: "csv",
  file: `${LODGES_PREFIX}<slug>/instructions.csv`,
  naturalKey: ["key"],
  singleton: false,
  fields: [...INSTRUCTION_FIELDS],
});
registerEntity({
  entity: "chore-template",
  category: "lodge-config",
  tier: "key-weak",
  format: "csv",
  file: `${LODGES_PREFIX}<slug>/chore-templates.csv`,
  naturalKey: ["name"],
  singleton: false,
  fields: [...CHORE_FIELDS],
});

const coerceInt = (v: string | undefined, d: number) =>
  Number.isFinite(Number.parseInt((v ?? "").trim(), 10)) ? Number.parseInt(v as string, 10) : d;
const coerceBool = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "true";
const nz = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : null);
const nzInt = (v: string | undefined) => {
  const s = nz(v);
  return s === null ? null : Number.parseInt(s, 10);
};
const readCsv = (files: Map<string, Uint8Array>, path: string) => {
  const b = files.get(path);
  return b ? parseCsv(strFromU8(b)).rows : [];
};

async function slugToId(db: ReadDb | TxDb): Promise<Map<string, string>> {
  const lodges = await db.lodge.findMany({ select: { id: true, slug: true } });
  return new Map(lodges.map((l) => [l.slug, l.id]));
}

export const lodgeOpsExporter: CategoryExporter = {
  category: "lodge-config",
  descriptors: [],
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const instructions = await ctx.db.lodgeInstruction.findMany({
      orderBy: { key: "asc" },
      select: { key: true, contentHtml: true, lodge: { select: { slug: true } } },
    });
    const chores = await ctx.db.choreTemplate.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        name: true, description: true, recommendedPeopleMin: true,
        recommendedPeopleMax: true, isEssential: true, ageRestriction: true,
        conditionalNote: true, minAge: true, sortOrder: true, timeOfDay: true,
        frequencyMode: true, frequencyDays: true, active: true,
        lodge: { select: { slug: true } },
      },
    });

    for (const i of instructions) {
      for (const id of extractImageIds(i.contentHtml ?? "")) ctx.media.reference(id);
    }

    // Group instructions: club-wide (no lodge) vs per-lodge.
    const clubInstructions: Record<string, unknown>[] = [];
    const instructionsByLodge = new Map<string, Record<string, unknown>[]>();
    for (const i of instructions) {
      const row = { key: i.key, contentHtml: i.contentHtml };
      if (i.lodge?.slug) {
        const list = instructionsByLodge.get(i.lodge.slug) ?? [];
        list.push(row);
        instructionsByLodge.set(i.lodge.slug, list);
      } else {
        clubInstructions.push(row);
      }
    }
    const choresByLodge = new Map<string, Record<string, unknown>[]>();
    for (const c of chores) {
      const list = choresByLodge.get(c.lodge.slug) ?? [];
      list.push({
        name: c.name, description: c.description,
        recommendedPeopleMin: c.recommendedPeopleMin, recommendedPeopleMax: c.recommendedPeopleMax,
        isEssential: c.isEssential, ageRestriction: c.ageRestriction, conditionalNote: c.conditionalNote,
        minAge: c.minAge, sortOrder: c.sortOrder, timeOfDay: c.timeOfDay,
        frequencyMode: c.frequencyMode, frequencyDays: c.frequencyDays, active: c.active,
      });
      choresByLodge.set(c.lodge.slug, list);
    }

    // Always emit the top-level club-wide (lodgeId null) instructions file so
    // the "shown for every lodge unless overridden" slot is discoverable.
    const entries: BundleEntry[] = [
      { path: CLUB_INSTRUCTION_FILE, category: "lodge-config", rowCount: clubInstructions.length, bytes: strToU8(serialiseCsv([...INSTRUCTION_FIELDS], clubInstructions)) },
    ];

    // Emit the per-lodge instructions + chore-template skeletons for EVERY
    // lodge (header-only when empty), so each lodge folder captures the full
    // config and its per-lodge instruction-override slot is visible.
    const lodges = await ctx.db.lodge.findMany({ orderBy: { slug: "asc" }, select: { slug: true } });
    const segmentFor = (slug: string) => slug.replace(/[^A-Za-z0-9._-]/g, "_");
    for (const { slug } of lodges) {
      const paths = lodgeFolderFiles(segmentFor(slug));
      const ins = instructionsByLodge.get(slug) ?? [];
      const ch = choresByLodge.get(slug) ?? [];
      entries.push({ path: paths.instructions, category: "lodge-config", rowCount: ins.length, bytes: strToU8(serialiseCsv([...INSTRUCTION_FIELDS], ins)) });
      entries.push({ path: paths.choreTemplates, category: "lodge-config", rowCount: ch.length, bytes: strToU8(serialiseCsv([...CHORE_FIELDS], ch)) });
    }
    return entries;
  },
};

async function planLodgeOps(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const fingerprintParts: string[] = [];
  const map = await slugToId(ctx.db);

  // Club-wide instructions (lodgeId null).
  for (const raw of readCsv(ctx.files, CLUB_INSTRUCTION_FILE)) {
    const key = `club/${raw.key}`;
    const current = await ctx.db.lodgeInstruction.findFirst({
      where: { lodgeId: null, key: (raw.key ?? "") as never },
      select: { id: true },
    });
    fingerprintParts.push(`lodge-instruction:${key}:${current ? "present" : "absent"}`);
    items.push({ entity: "lodge-instruction", key, action: current ? "update" : "create" });
  }

  // Per-lodge instructions + chore templates.
  for (const segment of lodgeFolderSegments(ctx.files)) {
    const slug = folderLodgeSlug(ctx.files, segment);
    if (!slug) continue;
    const paths = lodgeFolderFiles(segment);
    const lodgeId = map.get(slug) ?? null;

    for (const raw of readCsv(ctx.files, paths.instructions)) {
      const key = `${slug}/${raw.key}`;
      const current = lodgeId
        ? await ctx.db.lodgeInstruction.findFirst({ where: { lodgeId, key: (raw.key ?? "") as never }, select: { id: true } })
        : null;
      fingerprintParts.push(`lodge-instruction:${key}:${current ? "present" : "absent"}`);
      items.push({ entity: "lodge-instruction", key, action: current ? "update" : "create" });
    }

    for (const raw of readCsv(ctx.files, paths.choreTemplates)) {
      const key = `${slug}/${raw.name}`;
      const current = lodgeId
        ? await ctx.db.choreTemplate.findFirst({ where: { lodgeId, name: raw.name ?? "" }, select: { name: true, sortOrder: true, active: true } })
        : null;
      fingerprintParts.push(`chore-template:${key}:${current ? hashRow(["name", "sortOrder", "active"], current) : "absent"}`);
      items.push({ entity: "chore-template", key, action: current ? "update" : "create" });
    }
  }

  return { items, warnings: [], fingerprintParts };
}

async function applyLodgeOps(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  const map = await slugToId(ctx.tx);

  const upsertInstruction = async (
    lodgeId: string | null,
    key: string,
    contentHtml: string | undefined,
  ) => {
    const html = sanitizePageContentHtml(remapImageRefs(contentHtml ?? "", ctx.imageRemap));
    const existing = await ctx.tx.lodgeInstruction.findFirst({
      where: { lodgeId, key: (key ?? "") as never },
      select: { id: true },
    });
    if (existing) {
      // Merge: a blank instruction body keeps the existing content.
      await ctx.tx.lodgeInstruction.update({
        where: { id: existing.id },
        data: updateDataForMode(ctx.mode, { contentHtml: contentHtml ?? "" }, { contentHtml: html }),
      });
      result.updated += 1;
    } else {
      await ctx.tx.lodgeInstruction.create({ data: { lodgeId, key: (key ?? "") as never, contentHtml: html } });
      result.created += 1;
    }
  };

  // Club-wide instructions.
  for (const raw of readCsv(ctx.files, CLUB_INSTRUCTION_FILE)) {
    await upsertInstruction(null, raw.key ?? "", raw.contentHtml);
  }

  // Per-lodge instructions + chore templates.
  for (const segment of lodgeFolderSegments(ctx.files)) {
    const slug = folderLodgeSlug(ctx.files, segment);
    const paths = lodgeFolderFiles(segment);
    const lodgeId = slug ? map.get(slug) ?? null : null;

    for (const raw of readCsv(ctx.files, paths.instructions)) {
      if (!lodgeId) { result.skipped += 1; continue; }
      await upsertInstruction(lodgeId, raw.key ?? "", raw.contentHtml);
    }

    for (const raw of readCsv(ctx.files, paths.choreTemplates)) {
      if (!lodgeId) { result.skipped += 1; continue; }
      const name = raw.name ?? "";
      if (!name) { result.skipped += 1; continue; }
      const data = {
        description: nz(raw.description),
        recommendedPeopleMin: coerceInt(raw.recommendedPeopleMin, 1),
        recommendedPeopleMax: coerceInt(raw.recommendedPeopleMax, 2),
        isEssential: coerceBool(raw.isEssential),
        ageRestriction: (raw.ageRestriction || "ANY") as never,
        conditionalNote: nz(raw.conditionalNote),
        minAge: coerceInt(raw.minAge, 0),
        sortOrder: coerceInt(raw.sortOrder, 0),
        timeOfDay: (raw.timeOfDay || "ANYTIME") as never,
        frequencyMode: (raw.frequencyMode || "DAILY") as never,
        frequencyDays: nzInt(raw.frequencyDays),
        active: coerceBool(raw.active),
      };
      const existing = await ctx.tx.choreTemplate.findFirst({ where: { lodgeId, name }, select: { id: true } });
      if (existing) {
        await ctx.tx.choreTemplate.update({ where: { id: existing.id }, data: updateDataForMode(ctx.mode, raw, data) });
        result.updated += 1;
      } else {
        await ctx.tx.choreTemplate.create({ data: { lodgeId, name, ...data } });
        result.created += 1;
      }
    }
  }

  return result;
}

export const lodgeOpsImporter: CategoryImporter = {
  category: "lodge-config",
  plan: planLodgeOps,
  apply: applyLodgeOps,
};
