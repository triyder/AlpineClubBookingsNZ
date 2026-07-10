import { strToU8, strFromU8 } from "fflate";

import type { BundleEntry } from "../bundle";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  changedFields,
  hashRow,
  planActionFor,
  resolutionKey,
  updateDataForMode,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
  type ReadDb,
} from "../import-types";
import { prismaEnumValues } from "../values";

// induction category: induction checklist templates with their nested sections
// and items, as a single JSON document (the nested rows have no natural key of
// their own, so they travel inside the parent template — ADR-001 "document
// entities"). Member-specific induction results are out of scope. Upsert-only:
// templates matched by (name, version) — or an admin-picked rename resolution —
// sections by (template, title), items by (section, label); nothing is deleted.

const FILE = "induction/templates.json";

registerEntity({
  entity: "induction-template",
  category: "induction",
  tier: "key-weak",
  format: "json",
  file: FILE,
  naturalKey: ["name", "version"],
  singleton: false,
  fields: ["name", "version", "kind", "sourceLabel", "isActive"],
});

interface ItemDoc {
  label: string;
  competencyPrompt: string | null;
  notesPrompt: string | null;
  isMandatory: boolean;
  requiresDemonstration: boolean;
  sortOrder: number;
  legacySourceText: string | null;
}
interface SectionDoc {
  title: string;
  description: string | null;
  priority: string;
  sortOrder: number;
  items: ItemDoc[];
}
interface TemplateDoc {
  name: string;
  version: string;
  kind: string;
  sourceLabel: string | null;
  isActive: boolean;
  sections: SectionDoc[];
}

/** Template-level write-data (leaf fields), shared by plan (diff) and apply. */
function buildTemplateData(tpl: TemplateDoc) {
  return {
    kind: tpl.kind as never,
    sourceLabel: tpl.sourceLabel ?? null,
    isActive: Boolean(tpl.isActive),
  };
}

/** Stable canonical string of a template's sections+items, for change detection. */
function canonicalNested(sections: unknown): string {
  const arr = Array.isArray(sections) ? (sections as Record<string, unknown>[]) : [];
  const norm = arr
    .map((s) => ({
      title: String(s.title ?? ""),
      description: s.description ?? null,
      priority: s.priority ?? null,
      sortOrder: s.sortOrder ?? 0,
      items: (Array.isArray(s.items) ? (s.items as Record<string, unknown>[]) : [])
        .map((i) => ({
          label: String(i.label ?? ""),
          competencyPrompt: i.competencyPrompt ?? null,
          notesPrompt: i.notesPrompt ?? null,
          isMandatory: Boolean(i.isMandatory),
          requiresDemonstration: Boolean(i.requiresDemonstration),
          sortOrder: i.sortOrder ?? 0,
          legacySourceText: i.legacySourceText ?? null,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return JSON.stringify(norm);
}

/**
 * Parse + strictly validate induction/templates.json (errors block apply): the
 * document must be an array of templates with string name/version, a real
 * InductionKind, and sections/items whose enums, booleans, and sort orders are
 * the right shape — a hand-edited typo fails the dry-run, not the transaction.
 */
function readTemplates(
  files: Map<string, Uint8Array>,
  errors: string[],
): TemplateDoc[] {
  const bytes = files.get(FILE);
  if (!bytes) return [];
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(bytes));
  } catch (error) {
    errors.push(
      `${FILE}: not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
    );
    return [];
  }
  if (!Array.isArray(json)) {
    errors.push(`${FILE}: must be a JSON array of templates`);
    return [];
  }
  const kinds = prismaEnumValues("InductionKind");
  const priorities = prismaEnumValues("InductionSectionPriority");
  const out: TemplateDoc[] = [];
  json.forEach((value, index) => {
    const at = `${FILE} template ${index + 1}`;
    const tpl = value as Partial<TemplateDoc> | null;
    if (!tpl || typeof tpl !== "object") {
      errors.push(`${at}: must be an object`);
      return;
    }
    let ok = true;
    const fail = (message: string) => {
      errors.push(`${at}: ${message}`);
      ok = false;
    };
    if (typeof tpl.name !== "string" || tpl.name.trim() === "") fail("name must be a non-empty string");
    if (typeof tpl.version !== "string" || tpl.version.trim() === "") fail("version must be a non-empty string");
    if (typeof tpl.kind !== "string" || !kinds.has(tpl.kind)) {
      fail(`kind must be one of: ${[...kinds].join(", ")}`);
    }
    if (tpl.isActive !== undefined && typeof tpl.isActive !== "boolean") fail("isActive must be true/false");
    const sections = tpl.sections ?? [];
    if (!Array.isArray(sections)) {
      fail("sections must be an array");
    } else {
      sections.forEach((section, sIndex) => {
        const sat = `section ${sIndex + 1}`;
        if (!section || typeof section !== "object") return fail(`${sat}: must be an object`);
        if (typeof section.title !== "string" || section.title.trim() === "") fail(`${sat}: title must be a non-empty string`);
        if (typeof section.priority !== "string" || !priorities.has(section.priority)) {
          fail(`${sat}: priority must be one of: ${[...priorities].join(", ")}`);
        }
        if (section.sortOrder !== undefined && !Number.isInteger(section.sortOrder)) fail(`${sat}: sortOrder must be a whole number`);
        const sectionItems = section.items ?? [];
        if (!Array.isArray(sectionItems)) {
          fail(`${sat}: items must be an array`);
        } else {
          sectionItems.forEach((item, iIndex) => {
            const iat = `${sat} item ${iIndex + 1}`;
            if (!item || typeof item !== "object") return fail(`${iat}: must be an object`);
            if (typeof item.label !== "string" || item.label.trim() === "") fail(`${iat}: label must be a non-empty string`);
            if (item.isMandatory !== undefined && typeof item.isMandatory !== "boolean") fail(`${iat}: isMandatory must be true/false`);
            if (item.requiresDemonstration !== undefined && typeof item.requiresDemonstration !== "boolean") fail(`${iat}: requiresDemonstration must be true/false`);
            if (item.sortOrder !== undefined && !Number.isInteger(item.sortOrder)) fail(`${iat}: sortOrder must be a whole number`);
          });
        }
      });
    }
    if (ok) out.push(tpl as TemplateDoc);
  });
  return out;
}

const TEMPLATE_SELECT = {
  id: true,
  name: true,
  version: true,
  kind: true,
  sourceLabel: true,
  isActive: true,
  sections: {
    select: {
      title: true, description: true, priority: true, sortOrder: true,
      items: {
        select: {
          label: true, competencyPrompt: true, notesPrompt: true,
          isMandatory: true, requiresDemonstration: true, sortOrder: true, legacySourceText: true,
        },
      },
    },
  },
} as const;

interface TemplateCurrent {
  id: string;
  name: string;
  version: string;
  kind: string;
  sourceLabel: string | null;
  isActive: boolean;
  sections: unknown;
}

async function loadTemplates(db: ReadDb): Promise<{
  byKey: Map<string, TemplateCurrent>;
  byId: Map<string, TemplateCurrent>;
  all: TemplateCurrent[];
}> {
  const rows = await db.inductionChecklistTemplate.findMany({ select: TEMPLATE_SELECT });
  const byKey = new Map<string, TemplateCurrent>();
  for (const row of rows) {
    const key = `${row.name}/${row.version}`;
    if (!byKey.has(key)) byKey.set(key, row); // key-weak: first match wins
  }
  return { byKey, byId: new Map(rows.map((r) => [r.id, r])), all: rows };
}

export const inductionExporter: CategoryExporter = {
  category: "induction",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const templates = await ctx.db.inductionChecklistTemplate.findMany({
      orderBy: [{ name: "asc" }, { version: "asc" }],
      select: {
        name: true,
        version: true,
        kind: true,
        sourceLabel: true,
        isActive: true,
        sections: {
          orderBy: { sortOrder: "asc" },
          select: {
            title: true,
            description: true,
            priority: true,
            sortOrder: true,
            items: {
              orderBy: { sortOrder: "asc" },
              select: {
                label: true,
                competencyPrompt: true,
                notesPrompt: true,
                isMandatory: true,
                requiresDemonstration: true,
                sortOrder: true,
                legacySourceText: true,
              },
            },
          },
        },
      },
    });
    return [
      {
        path: FILE,
        category: "induction",
        rowCount: templates.length,
        bytes: strToU8(JSON.stringify(templates, null, 2)),
      },
    ];
  },
};

async function planInduction(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  const templates = readTemplates(ctx.files, errors);
  const existing = await loadTemplates(ctx.db);
  const bundleKeys = new Set(templates.map((t) => `${t.name}/${t.version}`));

  for (const tpl of templates) {
    const key = `${tpl.name}/${tpl.version}`;
    const resolvedId = ctx.resolutions.get(resolutionKey("induction-template", key));
    const exactMatch = existing.byKey.get(key) ?? null;
    let current: TemplateCurrent | null = exactMatch;
    let candidates: PlanItem["candidates"];
    if (!exactMatch) {
      // Kept on RESOLVED rows too, so the admin can change or undo the match.
      const options = existing.all.filter(
        (t) => !bundleKeys.has(`${t.name}/${t.version}`),
      );
      if (options.length > 0) {
        candidates = options.map((t) => ({ id: t.id, label: `${t.name} (v${t.version})` }));
      }
    }
    if (resolvedId) {
      current = existing.byId.get(resolvedId) ?? null;
      if (!current) {
        errors.push(`Induction template "${key}": the matched template no longer exists — re-run the preview.`);
        continue;
      }
    }
    // Content-aware fingerprint: leaf fields + a hash of the nested document,
    // so a concurrent edit anywhere in the template trips the drift guard.
    fingerprintParts.push(
      `induction-template:${key}:${
        current
          ? `${hashRow(["name", "version", "kind", "sourceLabel", "isActive"], current)}:${hashRow(["nested"], { nested: canonicalNested(current.sections) })}`
          : "absent"
      }`,
    );
    const tplRecord = tpl as unknown as Record<string, unknown>;
    const data = resolvedId
      ? { name: tpl.name, version: tpl.version, ...buildTemplateData(tpl) }
      : buildTemplateData(tpl);
    const write = updateDataForMode(ctx.mode, tplRecord, data);
    const changed = changedFields(write, current);
    if (current && canonicalNested(tpl.sections) !== canonicalNested(current.sections)) {
      changed.push("sections");
    }
    items.push({
      entity: "induction-template",
      key,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
      ...(candidates ? { candidates } : {}),
    });
  }
  return { items, warnings: [], errors, fingerprintParts };
}

async function applyInduction(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive only
  const templates = readTemplates(ctx.files, errors);
  const existing = await loadTemplates(ctx.tx);

  for (const tpl of templates) {
    const key = `${tpl.name}/${tpl.version}`;
    const resolvedId = ctx.resolutions.get(resolutionKey("induction-template", key));
    const current = resolvedId
      ? existing.byId.get(resolvedId) ?? null
      : existing.byKey.get(key) ?? null;
    if (resolvedId && !current) { result.skipped += 1; continue; }

    const tplRecord = tpl as unknown as Record<string, unknown>;
    const data = resolvedId
      ? { name: tpl.name, version: tpl.version, ...buildTemplateData(tpl) }
      : buildTemplateData(tpl);

    let templateId: string;
    if (current) {
      const write = updateDataForMode(ctx.mode, tplRecord, data);
      const changed = changedFields(write, current);
      const nestedChanged =
        canonicalNested(tpl.sections) !== canonicalNested(current.sections);
      if (changed.length === 0 && !nestedChanged) {
        result.unchanged += 1;
        continue;
      }
      if (changed.length > 0) {
        await ctx.tx.inductionChecklistTemplate.update({
          where: { id: current.id },
          data: write,
        });
      }
      templateId = current.id;
      result.updated += 1;
    } else {
      const created = await ctx.tx.inductionChecklistTemplate.create({
        data: { name: tpl.name, version: tpl.version, ...buildTemplateData(tpl) },
        select: { id: true },
      });
      templateId = created.id;
      result.created += 1;
    }

    for (const section of tpl.sections ?? []) {
      const secData = {
        description: section.description ?? null,
        priority: section.priority as never,
        sortOrder: section.sortOrder ?? 0,
      };
      let sectionId: string;
      const existingSection = await ctx.tx.inductionChecklistSection.findFirst({
        where: { templateId, title: section.title },
        select: { id: true },
      });
      if (existingSection) {
        await ctx.tx.inductionChecklistSection.update({
          where: { id: existingSection.id },
          data: updateDataForMode(ctx.mode, section as unknown as Record<string, unknown>, secData),
        });
        sectionId = existingSection.id;
      } else {
        const createdSection = await ctx.tx.inductionChecklistSection.create({
          data: { templateId, title: section.title, ...secData },
          select: { id: true },
        });
        sectionId = createdSection.id;
      }

      for (const item of section.items ?? []) {
        const itemData = {
          competencyPrompt: item.competencyPrompt ?? null,
          notesPrompt: item.notesPrompt ?? null,
          isMandatory: Boolean(item.isMandatory),
          requiresDemonstration: Boolean(item.requiresDemonstration),
          sortOrder: item.sortOrder ?? 0,
          legacySourceText: item.legacySourceText ?? null,
        };
        const existingItem = await ctx.tx.inductionChecklistItem.findFirst({
          where: { sectionId, label: item.label },
          select: { id: true },
        });
        if (existingItem) {
          await ctx.tx.inductionChecklistItem.update({
            where: { id: existingItem.id },
            data: updateDataForMode(ctx.mode, item as unknown as Record<string, unknown>, itemData),
          });
        } else {
          await ctx.tx.inductionChecklistItem.create({ data: { sectionId, label: item.label, ...itemData } });
        }
      }
    }
  }
  return result;
}

export const inductionImporter: CategoryImporter = {
  category: "induction",
  plan: planInduction,
  apply: applyInduction,
};
