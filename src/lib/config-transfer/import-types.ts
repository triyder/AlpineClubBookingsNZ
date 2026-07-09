import { createHash } from "node:crypto";

import type { PrismaClient, Prisma } from "@prisma/client";

import type { ConfigTransferCategory, ConfigTransferManifest } from "./manifest";

// Import-side contracts: plan (dry-run) and apply. Upsert-only, never delete
// (ADR-002). The plan is stateless — recomputed at apply time and guarded by a
// fingerprint of the touched rows so a concurrent DB change forces a re-plan.

export type ReadDb = PrismaClient;
export type TxDb = Prisma.TransactionClient;

/**
 * How an import writes fields onto an EXISTING row:
 * - "merge" (default): only fields whose bundle value is present + non-empty are
 *   written; blank/omitted fields keep the target's existing value. Safe with
 *   the always-emitted full skeleton — a partial bundle patches, never wipes.
 * - "overwrite": the bundle fully defines the row; blank fields clear the target.
 * Creates always use the bundle's values regardless of mode (nothing to keep).
 */
export type ImportMode = "merge" | "overwrite";

/** True if a bundle row carries a present, non-empty value for `field`. */
export function rawHasValue(
  raw: Record<string, unknown>,
  field: string,
): boolean {
  return String(raw[field] ?? "").trim() !== "";
}

/**
 * The field set to write on UPDATE for the given mode. In merge mode, drop any
 * field whose bundle source (`raw`) is blank/omitted so the target keeps its
 * existing value; in overwrite mode, write everything. `data` keys must match
 * the bundle column/key names (they do across all categories).
 */
export function updateDataForMode<T extends Record<string, unknown>>(
  mode: ImportMode,
  raw: Record<string, unknown>,
  data: T,
): Partial<T> {
  if (mode === "overwrite") return data;
  const out: Partial<T> = {};
  for (const key of Object.keys(data) as (keyof T & string)[]) {
    if (rawHasValue(raw, key)) out[key] = data[key];
  }
  return out;
}

/**
 * Canonical string form of a field value for change detection. Compares the
 * value the apply WOULD write (already coerced to its DB type) against the
 * current DB value — both are the same type, so this canonical form (date-only
 * for Date, "" for null/undefined, String() otherwise) compares them accurately
 * without false positives from formatting.
 */
export function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  }
  return String(value);
}

/**
 * The allowlisted fields that differ between the write-data (what apply would
 * write for the chosen mode) and the current row. Empty when nothing changes,
 * so the planner can reclassify a no-op update as "unchanged".
 */
export function changedFields(
  writeData: Record<string, unknown>,
  current: Record<string, unknown> | null,
): string[] {
  if (!current) return [];
  const changed: string[] = [];
  for (const field of Object.keys(writeData)) {
    if (canonicalValue(writeData[field]) !== canonicalValue(current[field])) {
      changed.push(field);
    }
  }
  return changed;
}

/**
 * Classify an existing/absent row into a plan action for the chosen mode. A row
 * that exists but whose write-data matches the current values is "unchanged".
 */
export function planActionFor(
  current: Record<string, unknown> | null,
  changed: string[],
): PlanAction {
  if (!current) return "create";
  return changed.length > 0 ? "update" : "unchanged";
}

export type PlanAction = "create" | "update" | "unchanged";

export interface PlanItem {
  entity: string;
  /** Display value of the natural key, e.g. the slug. */
  key: string;
  action: PlanAction;
  /** For updates: which allowlisted fields differ. */
  changedFields?: string[];
}

export interface CategoryPlanResult {
  items: PlanItem[];
  /** Behaviour-change / ambiguity notes surfaced in the dry-run. */
  warnings: string[];
  /**
   * Stable strings describing the CURRENT state of every row this category
   * would touch. Hashed into the global fingerprint so apply can detect drift
   * since the plan was shown.
   */
  fingerprintParts: string[];
}

export interface CategoryPlan extends CategoryPlanResult {
  category: ConfigTransferCategory;
}

export interface ImportPlan {
  formatVersion: number;
  categories: CategoryPlan[];
  fingerprint: string;
  doorCodesIncluded: boolean;
  /**
   * Advisory bundle-integrity notes (checksum drift, declared-but-missing or
   * present-but-undeclared files) from a hand-edited bundle. Shown in the
   * dry-run; never blocks. See ADR-001 "hand-edit".
   */
  integrityWarnings: string[];
  xero: {
    sourceTenantId: string | null;
    targetTenantId: string | null;
    mismatch: boolean;
  };
  summary: { create: number; update: number; unchanged: number };
}

export interface CategoryApplyResult {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export interface PlanContext {
  db: ReadDb;
  files: Map<string, Uint8Array>;
  manifest: ConfigTransferManifest;
  /** Drives the per-field change preview: merge ignores blank fields. */
  mode: ImportMode;
}

export interface ApplyContext {
  tx: TxDb;
  files: Map<string, Uint8Array>;
  manifest: ConfigTransferManifest;
  /** merge (blank fields keep existing) vs overwrite (blank fields clear). */
  mode: ImportMode;
  /** Member id performing the import, for audit-of-who fields. */
  actorMemberId: string;
  /** Old MediaImage id → new id, for rewriting /api/images/<id> in content. */
  imageRemap: Map<string, string>;
}

export interface CategoryImporter {
  category: ConfigTransferCategory;
  plan(ctx: PlanContext): Promise<CategoryPlanResult>;
  apply(ctx: ApplyContext): Promise<CategoryApplyResult>;
}

/** Stable content hash of an allowlisted row projection (order-independent). */
export function hashRow(fields: string[], row: Record<string, unknown>): string {
  const ordered = [...fields].sort();
  const canonical = JSON.stringify(
    ordered.map((f) => [f, row[f] ?? null]),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Compute the global fingerprint from every category's parts (order-stable). */
export function computeFingerprint(parts: string[]): string {
  return createHash("sha256")
    .update([...parts].sort().join("\n"))
    .digest("hex");
}
