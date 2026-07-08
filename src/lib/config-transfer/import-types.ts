import { createHash } from "node:crypto";

import type { PrismaClient, Prisma } from "@prisma/client";

import type { ConfigTransferCategory, ConfigTransferManifest } from "./manifest";

// Import-side contracts: plan (dry-run) and apply. Upsert-only, never delete
// (ADR-002). The plan is stateless — recomputed at apply time and guarded by a
// fingerprint of the touched rows so a concurrent DB change forces a re-plan.

export type ReadDb = PrismaClient;
export type TxDb = Prisma.TransactionClient;

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
}

export interface ApplyContext {
  tx: TxDb;
  files: Map<string, Uint8Array>;
  manifest: ConfigTransferManifest;
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
