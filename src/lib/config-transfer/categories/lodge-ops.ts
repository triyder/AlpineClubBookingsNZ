import { strToU8, strFromU8 } from "fflate";

import { sanitizePageContentHtml } from "@/lib/page-content-html";
import type { BundleEntry } from "../bundle";
import { serialiseCsv, parseCsv } from "../csv";
import { registerEntity } from "../registry";
import { remapImageRefs } from "../media";
import type { CategoryExporter, ExportContext } from "../export-types";
import { extractImageIds } from "./site-content";
import {
  hashRow,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
  type ReadDb,
  type TxDb,
} from "../import-types";

// lodge-config category (part 2): lodge instructions (per-lodge or club-wide,
// content may embed images) and chore templates. Booking/cancellation/min-stay
// policies are intentionally deferred — they use replace-the-whole-tier-set
// semantics that conflict with the upsert-only model and touch refund maths, so
// getting them subtly wrong is unsafe. See ADR-001/002.

const INSTRUCTION_FILE = "lodge-config/instructions.csv";
const CHORE_FILE = "lodge-config/chore-templates.csv";

const INSTRUCTION_FIELDS = ["lodgeSlug", "key", "contentHtml"] as const;
const CHORE_FIELDS = [
  "lodgeSlug", "name", "description", "recommendedPeopleMin",
  "recommendedPeopleMax", "isEssential", "ageRestriction", "conditionalNote",
  "minAge", "sortOrder", "timeOfDay", "frequencyMode", "frequencyDays", "active",
] as const;

registerEntity({
  entity: "lodge-instruction",
  category: "lodge-config",
  tier: "key-weak",
  format: "csv",
  file: INSTRUCTION_FILE,
  naturalKey: ["lodgeSlug", "key"],
  singleton: false,
  fields: [...INSTRUCTION_FIELDS],
});
registerEntity({
  entity: "chore-template",
  category: "lodge-config",
  tier: "key-weak",
  format: "csv",
  file: CHORE_FILE,
  naturalKey: ["lodgeSlug", "name"],
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

    const instructionRows = instructions.map((i) => ({
      lodgeSlug: i.lodge?.slug ?? "",
      key: i.key,
      contentHtml: i.contentHtml,
    }));
    const choreRows = chores.map((c) => ({
      lodgeSlug: c.lodge.slug,
      name: c.name,
      description: c.description,
      recommendedPeopleMin: c.recommendedPeopleMin,
      recommendedPeopleMax: c.recommendedPeopleMax,
      isEssential: c.isEssential,
      ageRestriction: c.ageRestriction,
      conditionalNote: c.conditionalNote,
      minAge: c.minAge,
      sortOrder: c.sortOrder,
      timeOfDay: c.timeOfDay,
      frequencyMode: c.frequencyMode,
      frequencyDays: c.frequencyDays,
      active: c.active,
    }));

    return [
      { path: INSTRUCTION_FILE, category: "lodge-config", rowCount: instructionRows.length, bytes: strToU8(serialiseCsv([...INSTRUCTION_FIELDS], instructionRows)) },
      { path: CHORE_FILE, category: "lodge-config", rowCount: choreRows.length, bytes: strToU8(serialiseCsv([...CHORE_FIELDS], choreRows)) },
    ];
  },
};

async function planLodgeOps(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const fingerprintParts: string[] = [];
  const map = await slugToId(ctx.db);

  for (const raw of readCsv(ctx.files, INSTRUCTION_FILE)) {
    const key = `${raw.lodgeSlug || "club"}/${raw.key}`;
    const lodgeId = raw.lodgeSlug ? map.get(raw.lodgeSlug) ?? null : null;
    const current = await ctx.db.lodgeInstruction.findFirst({
      where: { lodgeId, key: (raw.key ?? "") as never },
      select: { id: true },
    });
    fingerprintParts.push(`lodge-instruction:${key}:${current ? "present" : "absent"}`);
    items.push({ entity: "lodge-instruction", key, action: current ? "update" : "create" });
  }

  for (const raw of readCsv(ctx.files, CHORE_FILE)) {
    const key = `${raw.lodgeSlug}/${raw.name}`;
    const lodgeId = map.get(raw.lodgeSlug ?? "");
    const current = lodgeId
      ? await ctx.db.choreTemplate.findFirst({
          where: { lodgeId, name: raw.name ?? "" },
          select: { name: true, sortOrder: true, active: true },
        })
      : null;
    fingerprintParts.push(`chore-template:${key}:${current ? hashRow(["name", "sortOrder", "active"], current) : "absent"}`);
    items.push({ entity: "chore-template", key, action: current ? "update" : "create" });
  }

  return { items, warnings: [], fingerprintParts };
}

async function applyLodgeOps(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  const map = await slugToId(ctx.tx);

  for (const raw of readCsv(ctx.files, INSTRUCTION_FILE)) {
    const lodgeId = raw.lodgeSlug ? map.get(raw.lodgeSlug) ?? null : null;
    if (raw.lodgeSlug && !lodgeId) { result.skipped += 1; continue; }
    const html = sanitizePageContentHtml(remapImageRefs(raw.contentHtml ?? "", ctx.imageRemap));
    const existing = await ctx.tx.lodgeInstruction.findFirst({
      where: { lodgeId, key: (raw.key ?? "") as never },
      select: { id: true },
    });
    if (existing) {
      await ctx.tx.lodgeInstruction.update({ where: { id: existing.id }, data: { contentHtml: html } });
      result.updated += 1;
    } else {
      await ctx.tx.lodgeInstruction.create({ data: { lodgeId, key: (raw.key ?? "") as never, contentHtml: html } });
      result.created += 1;
    }
  }

  for (const raw of readCsv(ctx.files, CHORE_FILE)) {
    const lodgeId = map.get(raw.lodgeSlug ?? "");
    if (!lodgeId) { result.skipped += 1; continue; }
    const name = raw.name ?? "";
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
    const existing = await ctx.tx.choreTemplate.findFirst({
      where: { lodgeId, name },
      select: { id: true },
    });
    if (existing) {
      await ctx.tx.choreTemplate.update({ where: { id: existing.id }, data });
      result.updated += 1;
    } else {
      await ctx.tx.choreTemplate.create({ data: { lodgeId, name, ...data } });
      result.created += 1;
    }
  }

  return result;
}

export const lodgeOpsImporter: CategoryImporter = {
  category: "lodge-config",
  plan: planLodgeOps,
  apply: applyLodgeOps,
};
