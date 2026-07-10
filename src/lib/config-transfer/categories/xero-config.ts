import { strToU8, strFromU8 } from "fflate";
import { z } from "zod";

import type { BundleEntry } from "../bundle";
import { serialiseCsv } from "../csv";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  applyRow,
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
import { RowValidator, nz, readCsvRows } from "../values";

// xero-config category: the accounting mappings — GL account/item-code mappings
// and per-category item codes. Contact-group rules/accepted-groups are excluded
// (they FK to member types / age-tier settings and are Xero-org-specific).
// The source Xero tenant id is recorded in xero-config/source.json (sealed with
// the rest of the category, so it only exists when Xero is exported); the plan
// warns on an org mismatch so codes are verified before applying (ADR-002).
//
// Item-code identity: the FULL natural key (category, ageTier, seasonType,
// isMember, entranceFeeCategory) INCLUDING nulls, matched via an in-memory map
// — never the compound unique with a null coerced to false, which could not
// match a null row and duplicated it on every import.

const ACCOUNT_FILE = "xero-config/account-mappings.csv";
const ITEM_FILE = "xero-config/item-code-mappings.csv";
/** Provenance: the Xero org connected at export time. Category-local, sealed. */
const XERO_SOURCE_FILE = "xero-config/source.json";

const ACCOUNT_FIELDS = ["key", "code", "itemCode"] as const;
const ITEM_FIELDS = [
  "category", "ageTier", "seasonType", "isMember", "entranceFeeCategory",
  "itemCode", "amountCents",
] as const;

/** XeroItemCodeMapping.category is a plain string column with two known values. */
const ITEM_CATEGORIES = new Set(["HUT_FEE", "ENTRANCE_FEE"]);

const xeroSourceSchema = z.object({ tenantId: z.string().nullable() });

/** Read the source Xero tenant id from the bundle (null if absent/unparseable). */
export function readXeroSourceTenantId(
  files: Map<string, Uint8Array>,
): string | null {
  const bytes = files.get(XERO_SOURCE_FILE);
  if (!bytes) return null;
  try {
    const parsed = xeroSourceSchema.safeParse(JSON.parse(strFromU8(bytes)));
    return parsed.success ? parsed.data.tenantId : null;
  } catch {
    return null;
  }
}

/**
 * The connected Xero org (tenant) id, or null. Single definition shared by the
 * export-side provenance stamp and the import-side cross-org check, so both
 * halves of the invariant always agree.
 */
export async function connectedXeroTenantId(db: ReadDb): Promise<string | null> {
  const token = await db.xeroToken.findFirst({
    select: { tenantId: true },
    orderBy: { updatedAt: "desc" },
  });
  return token?.tenantId ?? null;
}

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

// ---- Shared parsing + batched state -----------------------------------------

/** Null-honest natural key for an item-code row ("-" marks null). */
function itemKeyOf(parts: {
  category: string;
  ageTier: string | null;
  seasonType: string | null;
  isMember: boolean | null;
  entranceFeeCategory: string | null;
}): string {
  return [parts.category, parts.ageTier, parts.seasonType, parts.isMember, parts.entranceFeeCategory]
    .map((v) => (v === null || v === undefined ? "-" : String(v)))
    .join("/");
}

interface ParsedItemRow {
  raw: Record<string, string>;
  key: string;
  identity: {
    category: string;
    ageTier: string | null;
    seasonType: string | null;
    isMember: boolean | null;
    entranceFeeCategory: string | null;
  };
  data: { itemCode: string | null; amountCents: number | null };
}

function parseItemRow(
  index: number,
  raw: Record<string, string>,
  errors: string[],
): ParsedItemRow | null {
  const v = new RowValidator(ITEM_FILE, index, errors);
  const category = v.required("category", raw.category);
  if (category && !ITEM_CATEGORIES.has(category)) {
    errors.push(
      `${ITEM_FILE} row ${index + 2}: category — "${category}" is not HUT_FEE or ENTRANCE_FEE`,
    );
    return null;
  }
  const identity = {
    category,
    ageTier: v.enumOrNull("ageTier", "AgeTier", raw.ageTier),
    seasonType: v.enumOrNull("seasonType", "SeasonType", raw.seasonType),
    isMember: nz(raw.isMember) === null ? null : v.bool("isMember", raw.isMember),
    entranceFeeCategory: v.enumOrNull("entranceFeeCategory", "EntranceFeeCategory", raw.entranceFeeCategory),
  };
  const data = {
    itemCode: nz(raw.itemCode),
    amountCents: nz(raw.amountCents) === null ? null : v.moneyCents("amountCents", raw.amountCents),
  };
  if (!v.ok) return null;
  return { raw, key: itemKeyOf(identity), identity, data };
}

interface XeroBatch {
  accounts: Map<string, { id: string; key: string; code: string | null; itemCode: string | null }>;
  items: Map<string, { id: string; itemCode: string | null; amountCents: number | null }>;
}

async function loadXeroBatch(db: ReadDb): Promise<XeroBatch> {
  const [accountRows, itemRows] = await Promise.all([
    db.xeroAccountMapping.findMany({
      select: { id: true, key: true, code: true, itemCode: true },
    }),
    db.xeroItemCodeMapping.findMany({
      select: {
        id: true, category: true, ageTier: true, seasonType: true,
        isMember: true, entranceFeeCategory: true, itemCode: true, amountCents: true,
      },
    }),
  ]);
  const items = new Map<string, { id: string; itemCode: string | null; amountCents: number | null }>();
  for (const row of itemRows) {
    const key = itemKeyOf(row);
    if (!items.has(key)) items.set(key, row); // first match wins on duplicates
  }
  return {
    accounts: new Map(accountRows.map((r) => [r.key, r])),
    items,
  };
}

// ---- Export ----------------------------------------------------------------

export const xeroConfigExporter: CategoryExporter = {
  category: "xero-config",
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

    const entries: BundleEntry[] = [];
    if (accounts.length > 0 || items.length > 0) {
      entries.push(
        { path: ACCOUNT_FILE, category: "xero-config", rowCount: accounts.length, bytes: strToU8(serialiseCsv([...ACCOUNT_FIELDS], accounts)) },
        { path: ITEM_FILE, category: "xero-config", rowCount: items.length, bytes: strToU8(serialiseCsv([...ITEM_FIELDS], items)) },
      );
    }

    // Stamp the connected Xero org for provenance whenever the category has any
    // content (or an org is connected), so import can warn on a cross-org apply.
    const tenantId = await connectedXeroTenantId(ctx.db);
    if (entries.length > 0 || tenantId) {
      entries.push({
        path: XERO_SOURCE_FILE,
        category: "xero-config",
        rowCount: null,
        bytes: strToU8(JSON.stringify({ tenantId }, null, 2)),
      });
    }
    return entries;
  },
};

// ---- Plan ------------------------------------------------------------------

async function planXeroConfig(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  const batch = await loadXeroBatch(ctx.db);

  readCsvRows(ctx.files, ACCOUNT_FILE).forEach((raw, i) => {
    const v = new RowValidator(ACCOUNT_FILE, i, errors);
    const key = v.required("key", raw.key);
    if (!v.ok) return;
    const current = batch.accounts.get(key) ?? null;
    fingerprintParts.push(
      `xero-account-mapping:${key}:${current ? hashRow([...ACCOUNT_FIELDS], current) : "absent"}`,
    );
    const write = updateDataForMode(ctx.mode, raw, { code: nz(raw.code), itemCode: nz(raw.itemCode) });
    const changed = changedFields(write, current);
    items.push({ entity: "xero-account-mapping", key, action: planActionFor(current, changed), changedFields: changed.length ? changed : undefined });
  });

  readCsvRows(ctx.files, ITEM_FILE).forEach((raw, i) => {
    const parsed = parseItemRow(i, raw, errors);
    if (!parsed) return;
    const current = batch.items.get(parsed.key) ?? null;
    fingerprintParts.push(
      `xero-item-code-mapping:${parsed.key}:${current ? hashRow(["itemCode", "amountCents"], current) : "absent"}`,
    );
    const write = updateDataForMode(ctx.mode, raw, parsed.data);
    const changed = changedFields(write, current);
    items.push({ entity: "xero-item-code-mapping", key: parsed.key, action: planActionFor(current, changed), changedFields: changed.length ? changed : undefined });
  });

  if (items.length > 0) {
    warnings.push("Xero codes are only valid for the connected Xero org — verify after importing.");
  }
  return { items, warnings, errors, fingerprintParts };
}

// ---- Apply -----------------------------------------------------------------

async function applyXeroConfig(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive only
  const batch = await loadXeroBatch(ctx.tx);

  for (const [i, raw] of readCsvRows(ctx.files, ACCOUNT_FILE).entries()) {
    const v = new RowValidator(ACCOUNT_FILE, i, errors);
    const key = v.required("key", raw.key);
    if (!v.ok) { result.skipped += 1; continue; }
    const current = batch.accounts.get(key) ?? null;
    await applyRow({
      mode: ctx.mode,
      raw,
      data: { code: nz(raw.code), itemCode: nz(raw.itemCode) },
      current,
      create: (data) => ctx.tx.xeroAccountMapping.create({ data: { key, ...data } }),
      update: (write) => ctx.tx.xeroAccountMapping.update({ where: { id: current!.id }, data: write }),
      result,
    });
  }

  for (const [i, raw] of readCsvRows(ctx.files, ITEM_FILE).entries()) {
    const parsed = parseItemRow(i, raw, errors);
    if (!parsed) { result.skipped += 1; continue; }
    const current = batch.items.get(parsed.key) ?? null;
    await applyRow({
      mode: ctx.mode,
      raw,
      data: parsed.data,
      current,
      create: (data) =>
        ctx.tx.xeroItemCodeMapping.create({
          data: {
            category: parsed.identity.category,
            ageTier: parsed.identity.ageTier as never,
            seasonType: parsed.identity.seasonType as never,
            isMember: parsed.identity.isMember,
            entranceFeeCategory: parsed.identity.entranceFeeCategory as never,
            ...data,
          },
        }),
      update: (write) => ctx.tx.xeroItemCodeMapping.update({ where: { id: current!.id }, data: write }),
      result,
    });
  }

  return result;
}

export const xeroConfigImporter: CategoryImporter = {
  category: "xero-config",
  plan: planXeroConfig,
  apply: applyXeroConfig,
};
