import { strToU8, strFromU8 } from "fflate";
import type { Prisma } from "@prisma/client";

import type { BundleEntry } from "../bundle";
import { serialiseCsv, parseCsv } from "../csv";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  hashRow,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
} from "../import-types";

// xero-config category: the accounting mappings — GL account/item-code mappings
// and per-category item codes. Contact-group rules/accepted-groups are excluded
// (they FK to member types / age-tier settings and are Xero-org-specific). The
// manifest stamps the source Xero tenant id; the plan warns on an org mismatch
// so codes are verified before applying (ADR-002).

const ACCOUNT_FILE = "xero-config/account-mappings.csv";
const ITEM_FILE = "xero-config/item-code-mappings.csv";

const ACCOUNT_FIELDS = ["key", "code", "itemCode"] as const;
const ITEM_FIELDS = [
  "category", "ageTier", "seasonType", "isMember", "entranceFeeCategory",
  "itemCode", "amountCents",
] as const;

registerEntity({
  entity: "xero-account-mapping",
  category: "xero-config",
  tier: "key-strong",
  format: "csv",
  file: ACCOUNT_FILE,
  naturalKey: ["key"],
  singleton: false,
  fields: [...ACCOUNT_FIELDS],
});
registerEntity({
  entity: "xero-item-code-mapping",
  category: "xero-config",
  tier: "key-strong",
  format: "csv",
  file: ITEM_FILE,
  naturalKey: ["category", "ageTier", "seasonType", "isMember", "entranceFeeCategory"],
  singleton: false,
  fields: [...ITEM_FIELDS],
});

const readCsv = (files: Map<string, Uint8Array>, path: string) => {
  const b = files.get(path);
  return b ? parseCsv(strFromU8(b)).rows : [];
};
const nz = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : null);
const nzInt = (v: string | undefined) => {
  const s = nz(v);
  return s === null ? null : Number.parseInt(s, 10);
};
const nzBool = (v: string | undefined) => {
  const s = nz(v);
  return s === null ? null : s.toLowerCase() === "true";
};

/** Build the correct compound-unique where for an item-code row by category. */
function itemWhere(row: Record<string, string>): Prisma.XeroItemCodeMappingWhereUniqueInput {
  if ((row.category ?? "") === "ENTRANCE_FEE") {
    return {
      category_entranceFeeCategory: {
        category: row.category ?? "",
        entranceFeeCategory: nz(row.entranceFeeCategory) as never,
      },
    };
  }
  return {
    category_ageTier_seasonType_isMember: {
      category: row.category ?? "",
      ageTier: nz(row.ageTier) as never,
      seasonType: nz(row.seasonType) as never,
      // HUT_FEE rows always carry isMember; the compound key requires non-null.
      isMember: nzBool(row.isMember) ?? false,
    },
  };
}

function itemKey(row: Record<string, unknown>): string {
  return [row.category, row.ageTier, row.seasonType, row.isMember, row.entranceFeeCategory]
    .map((v) => (v === null || v === undefined || v === "" ? "-" : v))
    .join("/");
}

export const xeroConfigExporter: CategoryExporter = {
  category: "xero-config",
  descriptors: [],
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const accounts = await ctx.db.xeroAccountMapping.findMany({
      orderBy: { key: "asc" },
      select: { key: true, code: true, itemCode: true },
    });
    const items = await ctx.db.xeroItemCodeMapping.findMany({
      orderBy: { category: "asc" },
      select: {
        category: true, ageTier: true, seasonType: true, isMember: true,
        entranceFeeCategory: true, itemCode: true, amountCents: true,
      },
    });
    return [
      { path: ACCOUNT_FILE, category: "xero-config", rowCount: accounts.length, bytes: strToU8(serialiseCsv([...ACCOUNT_FIELDS], accounts)) },
      { path: ITEM_FILE, category: "xero-config", rowCount: items.length, bytes: strToU8(serialiseCsv([...ITEM_FIELDS], items)) },
    ];
  },
};

async function planXeroConfig(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const fingerprintParts: string[] = [];

  for (const raw of readCsv(ctx.files, ACCOUNT_FILE)) {
    const key = raw.key ?? "";
    const current = await ctx.db.xeroAccountMapping.findUnique({
      where: { key },
      select: { key: true, code: true, itemCode: true },
    });
    fingerprintParts.push(`xero-account-mapping:${key}:${current ? hashRow([...ACCOUNT_FIELDS], current) : "absent"}`);
    items.push({ entity: "xero-account-mapping", key, action: current ? "update" : "create" });
  }

  for (const raw of readCsv(ctx.files, ITEM_FILE)) {
    const key = itemKey(raw);
    const current = await ctx.db.xeroItemCodeMapping.findUnique({
      where: itemWhere(raw),
      select: { id: true },
    });
    fingerprintParts.push(`xero-item-code-mapping:${key}:${current ? "present" : "absent"}`);
    items.push({ entity: "xero-item-code-mapping", key, action: current ? "update" : "create" });
  }

  if (items.length > 0) {
    warnings.push("Xero codes are only valid for the connected Xero org — verify after importing.");
  }
  return { items, warnings, fingerprintParts };
}

async function applyXeroConfig(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const raw of readCsv(ctx.files, ACCOUNT_FILE)) {
    const key = raw.key ?? "";
    if (!key) { result.skipped += 1; continue; }
    const data = { code: nz(raw.code), itemCode: nz(raw.itemCode) };
    const existing = await ctx.tx.xeroAccountMapping.findUnique({ where: { key }, select: { id: true } });
    await ctx.tx.xeroAccountMapping.upsert({ where: { key }, create: { key, ...data }, update: data });
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  for (const raw of readCsv(ctx.files, ITEM_FILE)) {
    const category = raw.category ?? "";
    if (!category) { result.skipped += 1; continue; }
    const where = itemWhere(raw);
    const data = { itemCode: nz(raw.itemCode), amountCents: nzInt(raw.amountCents) };
    const create = {
      category,
      ageTier: nz(raw.ageTier) as never,
      seasonType: nz(raw.seasonType) as never,
      isMember: nzBool(raw.isMember),
      entranceFeeCategory: nz(raw.entranceFeeCategory) as never,
      ...data,
    };
    const existing = await ctx.tx.xeroItemCodeMapping.findUnique({ where, select: { id: true } });
    await ctx.tx.xeroItemCodeMapping.upsert({ where, create, update: data });
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  return result;
}

export const xeroConfigImporter: CategoryImporter = {
  category: "xero-config",
  plan: planXeroConfig,
  apply: applyXeroConfig,
};
