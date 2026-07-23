import { strToU8 } from "fflate";
import type { AgeTier } from "@prisma/client";

import {
  validateAgeTierPartition,
  type AgeTierPartitionRow,
} from "@/lib/policies/age-tier";
import type { BundleEntry } from "../bundle";
import { serialiseCsv } from "../csv";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  applyRow,
  changedFields,
  hashRow,
  planActionFor,
  rawHasValue,
  updateDataForMode,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type ImportMode,
  type PlanContext,
  type PlanItem,
  type ReadDb,
} from "../import-types";
import { RowValidator, nz, readCsvRows } from "../values";

// age-tier entity (#2200): the club's per-tier age-classification POLICY —
// AgeTierSetting rows keyed by the AgeTier enum `tier` (@unique). Portable club
// reference data (age bounds, labels, the subscription-required and
// family-request-create flags, the display order) that underpins per-tier
// pricing and member classification. Multi-row, so it rides the membership-fees
// category as its own exporter/importer module (mirroring how lodge-config is
// split across modules) — the fee exporter/importer never touch AgeTierSetting.
//
//   membership-fees/age-tiers.csv
//     tier, minAge, maxAge, label, subscriptionRequiredForBooking,
//     familyGroupRequestCreateMemberAllowed, sortOrder
//     natural key: `tier` (AgeTier @unique).
//
// FIELD TREATMENT (#2200 audit): the seven columns above are exactly what
// getAgeTierSettings / the admin GET read — portable policy. Deliberately NOT
// exported: `id` (a per-install cuid, not referenced by any FK — every consumer
// keys off the AgeTier ENUM value, not this row id), and `createdAt`/`updatedAt`
// (instance-local audit). The legacy xeroContactGroupId/Name columns were DROPPED
// by the #2130 contract migration, so no Xero/tenant-adjacent field exists here.
//
// IMPORT (rekey by natural key): apply upserts BY `tier`, never by id — an
// imported row matches the destination's existing row for that tier and updates
// it in place (preserving the destination id), or creates a new row for a tier
// the target lacks. Because `tier` is @unique nothing can duplicate, and because
// no FK references AgeTierSetting.id nothing can be orphaned; upsert-only apply
// never deletes, so a tier the bundle omits is left untouched.
//
// PARTITION SAFETY: the admin save API enforces that the age tiers form a single
// complete, non-overlapping partition of [0,∞) with ADULT as the unbounded
// terminal tier (validateAgeTierPartition) and rejects NOT_APPLICABLE (the
// server-managed org/school tier that never has a row). Config transfer bypasses
// that API, so — exactly like membership-fees re-checks the fee-mix the DB does
// not enforce — the planner validates the EFFECTIVE POST-MERGE tier set (bundle
// rows upserted PLUS existing target tiers the bundle does not carry, which
// upsert-only apply leaves in place). A subset bundle that would leave the target
// with an overlapping/gapped partition is a blocking row error, not a silent
// misclassification.

const AGE_TIERS_FILE = "membership-fees/age-tiers.csv";

const AGE_TIER_FIELDS = [
  "tier",
  "minAge",
  "maxAge",
  "label",
  "subscriptionRequiredForBooking",
  "familyGroupRequestCreateMemberAllowed",
  "sortOrder",
] as const;

/** The policy columns written on create/update (everything but the natural key). */
const AGE_TIER_DATA_FIELDS = [
  "minAge",
  "maxAge",
  "label",
  "subscriptionRequiredForBooking",
  "familyGroupRequestCreateMemberAllowed",
  "sortOrder",
] as const;

registerEntity({
  entity: "age-tier",
  category: "membership-fees",
  // key-strong: AgeTierSetting.tier carries a DB @unique, so the importer may
  // upsert silently by tier (no interactive match).
  tier: "key-strong",
  format: "csv",
  file: AGE_TIERS_FILE,
  naturalKey: ["tier"],
  singleton: false,
  fields: [...AGE_TIER_FIELDS],
});

// ---- Current-state loading (shared by plan + apply) -------------------------

interface AgeTierCurrent {
  id: string;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking: boolean;
  familyGroupRequestCreateMemberAllowed: boolean;
  sortOrder: number;
}

async function loadAgeTiers(db: ReadDb): Promise<Map<string, AgeTierCurrent>> {
  const rows = await db.ageTierSetting.findMany({
    select: {
      id: true,
      tier: true,
      minAge: true,
      maxAge: true,
      label: true,
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: true,
      sortOrder: true,
    },
  });
  const byTier = new Map<string, AgeTierCurrent>();
  for (const r of rows) {
    byTier.set(r.tier, {
      id: r.id,
      minAge: r.minAge,
      maxAge: r.maxAge,
      label: r.label,
      subscriptionRequiredForBooking: r.subscriptionRequiredForBooking,
      familyGroupRequestCreateMemberAllowed: r.familyGroupRequestCreateMemberAllowed,
      sortOrder: r.sortOrder,
    });
  }
  return byTier;
}

// ---- Export ----------------------------------------------------------------

export const ageTierExporter: CategoryExporter = {
  category: "membership-fees",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const byTier = await loadAgeTiers(ctx.db);
    // No age tiers (an unseeded/empty install) → emit nothing, so the category is
    // simply absent for it (like the fee CSVs when there are no fees). A real
    // install always has the seeded tiers, so age-tiers.csv travels with it.
    if (byTier.size === 0) return [];

    // Deterministic, install-independent ordering (never DB ids): ascending
    // display order, tier name as a stable tiebreak, so export→import→export is
    // byte-stable.
    const rows = [...byTier.entries()]
      .map(([tier, cur]) => ({
        tier,
        minAge: cur.minAge,
        maxAge: cur.maxAge ?? "",
        label: cur.label,
        subscriptionRequiredForBooking: cur.subscriptionRequiredForBooking,
        familyGroupRequestCreateMemberAllowed: cur.familyGroupRequestCreateMemberAllowed,
        sortOrder: cur.sortOrder,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.tier.localeCompare(b.tier));

    return [
      {
        path: AGE_TIERS_FILE,
        category: "membership-fees",
        rowCount: rows.length,
        bytes: strToU8(serialiseCsv([...AGE_TIER_FIELDS], rows)),
      },
    ];
  },
};

// ---- Row parsing + strict validation (shared by plan + apply) ---------------

interface ParsedAgeTier {
  raw: Record<string, string>;
  tier: AgeTier;
  key: string;
  data: {
    minAge: number;
    maxAge: number | null;
    label: string;
    subscriptionRequiredForBooking: boolean;
    familyGroupRequestCreateMemberAllowed: boolean;
    sortOrder: number;
  };
}

const MAX_LABEL_LENGTH = 100; // mirrors the admin route's z.string().max(100)

function parseAgeTiers(
  files: Map<string, Uint8Array>,
  errors: string[],
): ParsedAgeTier[] {
  const out: ParsedAgeTier[] = [];
  const seenTiers = new Set<string>();
  readCsvRows(files, AGE_TIERS_FILE).forEach((raw, i) => {
    const v = new RowValidator(AGE_TIERS_FILE, i, errors);
    const tier = v.enum("tier", "AgeTier", raw.tier);
    // NOT_APPLICABLE is the server-managed organisation/school tier (#1440): it
    // has no age range and never gets a settings row, so a compliant bundle can
    // never carry it. Block it (mirrors the admin route's zod refine and
    // validateAgeTierPartition). Guarded on v.ok so a malformed enum reports once.
    if (v.ok && tier === "NOT_APPLICABLE") {
      errors.push(
        `${AGE_TIERS_FILE} row ${i + 2}: tier — NOT_APPLICABLE is the server-managed organisation/school tier and cannot be configured`,
      );
    }
    const minAge = v.int("minAge", raw.minAge);
    if (v.ok && minAge < 0) {
      errors.push(`${AGE_TIERS_FILE} row ${i + 2}: minAge — must be 0 or greater`);
    }
    const maxAge = nz(raw.maxAge) === null ? null : v.int("maxAge", raw.maxAge);
    if (v.ok && maxAge !== null && maxAge < 0) {
      errors.push(`${AGE_TIERS_FILE} row ${i + 2}: maxAge — must be 0 or greater (leave blank for the unbounded top tier)`);
    }
    const label = v.required("label", raw.label);
    if (v.ok && label.length > MAX_LABEL_LENGTH) {
      errors.push(`${AGE_TIERS_FILE} row ${i + 2}: label — must be at most ${MAX_LABEL_LENGTH} characters`);
    }
    const subscriptionRequiredForBooking = v.bool(
      "subscriptionRequiredForBooking",
      raw.subscriptionRequiredForBooking,
    );
    const familyGroupRequestCreateMemberAllowed = v.bool(
      "familyGroupRequestCreateMemberAllowed",
      raw.familyGroupRequestCreateMemberAllowed,
    );
    const sortOrder = v.int("sortOrder", raw.sortOrder);
    if (v.ok && sortOrder < 0) {
      errors.push(`${AGE_TIERS_FILE} row ${i + 2}: sortOrder — must be 0 or greater`);
    }
    if (!v.ok) return;
    // The natural key must be unique within the file: two rows for one tier can
    // never both apply (tier is @unique), so a duplicate is a blocking error.
    if (seenTiers.has(tier)) {
      errors.push(`${AGE_TIERS_FILE}: duplicate row for tier "${tier}" — each tier may appear at most once`);
      return;
    }
    seenTiers.add(tier);
    out.push({
      raw,
      tier: tier as AgeTier,
      key: tier,
      data: {
        minAge,
        maxAge,
        label,
        subscriptionRequiredForBooking,
        familyGroupRequestCreateMemberAllowed,
        sortOrder,
      },
    });
  });
  return out;
}

/**
 * Re-check the age-tier PARTITION against the EFFECTIVE POST-MERGE set, because
 * config transfer bypasses the admin API that normally enforces it and apply is
 * upsert-only (never deletes). The effective set = the bundle's tiers (with
 * minAge/maxAge resolved for the write mode) PLUS every existing target tier the
 * bundle does not carry (upsert-only apply leaves those in place). A bundle that
 * would leave an overlapping/gapped partition — e.g. a two-tier subset imported
 * onto a four-tier target — is blocked with an actionable error rather than
 * silently misclassifying member ages.
 */
function validatePostMergeAgeTierPartition(
  parsed: ParsedAgeTier[],
  current: Map<string, AgeTierCurrent>,
  mode: ImportMode,
  errors: string[],
): void {
  if (parsed.length === 0) return;
  const bundleTiers = new Set<string>(parsed.map((r) => r.tier));
  const effective: AgeTierPartitionRow[] = [];
  // Existing target tiers the bundle does not overwrite survive the apply.
  for (const [tier, cur] of current) {
    if (bundleTiers.has(tier)) continue;
    effective.push({ tier: tier as AgeTier, minAge: cur.minAge, maxAge: cur.maxAge });
  }
  // Bundle tiers, with minAge/maxAge resolved for the write mode (merge keeps the
  // DB value when the bundle cell is blank).
  for (const row of parsed) {
    const cur = current.get(row.tier) ?? null;
    const minAge =
      mode === "overwrite" || rawHasValue(row.raw, "minAge")
        ? row.data.minAge
        : cur?.minAge ?? row.data.minAge;
    const maxAge =
      mode === "overwrite" || rawHasValue(row.raw, "maxAge")
        ? row.data.maxAge
        : cur?.maxAge ?? row.data.maxAge;
    effective.push({ tier: row.tier, minAge, maxAge });
  }
  const result = validateAgeTierPartition(effective);
  if (!result.ok) {
    errors.push(
      `${AGE_TIERS_FILE}: importing these age tiers would leave the target's effective age partition invalid — ${result.error} ` +
        `Config transfer never deletes tiers, so a bundle that omits tiers the target still has cannot reshape the partition on its own; ` +
        `align the age tiers on the Age Tiers admin page first, then re-import.`,
    );
  }
}

// ---- Plan ------------------------------------------------------------------

async function planAgeTiers(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  // Files-first: a bundle without age-tiers.csv touches nothing (and never reads
  // the delegate), so an older bundle imports unchanged.
  if (!ctx.files.has(AGE_TIERS_FILE)) {
    return { items, warnings: [], errors, fingerprintParts };
  }
  const parsed = parseAgeTiers(ctx.files, errors);
  const current = await loadAgeTiers(ctx.db);
  validatePostMergeAgeTierPartition(parsed, current, ctx.mode, errors);

  for (const row of parsed) {
    const cur = current.get(row.tier) ?? null;
    fingerprintParts.push(
      `age-tier:${row.tier}:${cur ? hashRow([...AGE_TIER_DATA_FIELDS], cur) : "absent"}`,
    );
    const write = updateDataForMode(ctx.mode, row.raw, row.data);
    const changed = changedFields(write, cur);
    items.push({
      entity: "age-tier",
      key: row.key,
      action: planActionFor(cur, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }
  return { items, warnings: [], errors, fingerprintParts };
}

// ---- Apply -----------------------------------------------------------------

async function applyAgeTiers(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  if (!ctx.files.has(AGE_TIERS_FILE)) return result;
  const errors: string[] = []; // plan blocked all errors; defensive only
  const parsed = parseAgeTiers(ctx.files, errors);
  const current = await loadAgeTiers(ctx.tx);

  for (const row of parsed) {
    const cur = current.get(row.tier) ?? null;
    await applyRow({
      mode: ctx.mode,
      raw: row.raw,
      data: row.data,
      current: cur,
      // Rekey by natural key: create a row for a tier the target lacks (id is a
      // fresh cuid), or update the target's existing row for this tier IN PLACE
      // by its own id — never by a source id. tier @unique makes a duplicate
      // impossible; no FK references the id, so nothing is orphaned.
      // Both writes carry an explicit narrow `select` (the return value is
      // unused): AgeTierSetting is a doomed-column-guarded model, so a bare
      // create/update — which makes Prisma RETURNING every scalar — is forbidden
      // (doomed-column-select-guard.test.ts, #2130).
      create: (data) =>
        ctx.tx.ageTierSetting.create({
          data: { tier: row.tier, ...(data as object) } as never,
          select: { id: true },
        }),
      update: (write) =>
        ctx.tx.ageTierSetting.update({
          where: { id: cur!.id },
          data: write as never,
          select: { id: true },
        }),
      result,
    });
  }
  return result;
}

export const ageTierImporter: CategoryImporter = {
  category: "membership-fees",
  plan: planAgeTiers,
  apply: applyAgeTiers,
};
