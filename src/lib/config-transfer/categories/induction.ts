import { strToU8, strFromU8 } from "fflate";

import type { BundleEntry } from "../bundle";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  updateDataForMode,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
} from "../import-types";

// induction category: induction checklist templates with their nested sections
// and items, as a single JSON document (the nested rows have no natural key of
// their own, so they travel inside the parent template — ADR-001 "document
// entities"). Member-specific induction results are out of scope. Upsert-only:
// templates matched by (name, version), sections by (template, title), items by
// (section, label); nothing is deleted.

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

function readTemplates(files: Map<string, Uint8Array>): TemplateDoc[] {
  const bytes = files.get(FILE);
  if (!bytes) return [];
  return JSON.parse(strFromU8(bytes)) as TemplateDoc[];
}

export const inductionExporter: CategoryExporter = {
  category: "induction",
  descriptors: [],
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
  const fingerprintParts: string[] = [];
  for (const tpl of readTemplates(ctx.files)) {
    const key = `${tpl.name}/${tpl.version}`;
    const current = await ctx.db.inductionChecklistTemplate.findFirst({
      where: { name: tpl.name, version: tpl.version },
      select: { id: true },
    });
    fingerprintParts.push(`induction-template:${key}:${current ? "present" : "absent"}`);
    items.push({ entity: "induction-template", key, action: current ? "update" : "create" });
  }
  return { items, warnings: [], fingerprintParts };
}

async function applyInduction(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  for (const tpl of readTemplates(ctx.files)) {
    if (!tpl.name || !tpl.version) { result.skipped += 1; continue; }
    const tplData = {
      kind: tpl.kind as never,
      sourceLabel: tpl.sourceLabel ?? null,
      isActive: Boolean(tpl.isActive),
    };
    let templateId: string;
    const existing = await ctx.tx.inductionChecklistTemplate.findFirst({
      where: { name: tpl.name, version: tpl.version },
      select: { id: true },
    });
    if (existing) {
      await ctx.tx.inductionChecklistTemplate.update({ where: { id: existing.id }, data: updateDataForMode(ctx.mode, tpl as unknown as Record<string, unknown>, tplData) });
      templateId = existing.id;
      result.updated += 1;
    } else {
      const created = await ctx.tx.inductionChecklistTemplate.create({
        data: { name: tpl.name, version: tpl.version, ...tplData },
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
        await ctx.tx.inductionChecklistSection.update({ where: { id: existingSection.id }, data: updateDataForMode(ctx.mode, section as unknown as Record<string, unknown>, secData) });
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
          await ctx.tx.inductionChecklistItem.update({ where: { id: existingItem.id }, data: updateDataForMode(ctx.mode, item as unknown as Record<string, unknown>, itemData) });
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
