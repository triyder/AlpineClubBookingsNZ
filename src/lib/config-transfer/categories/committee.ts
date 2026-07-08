import { strToU8, strFromU8 } from "fflate";

import type { BundleEntry } from "../bundle";
import { serialiseCsv, parseCsv } from "../csv";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  hashRow,
  updateDataForMode,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
} from "../import-types";

// committee category: the CommitteeRole definitions that back the live
// (member-linked) committee page — President, Treasurer, etc., with their
// contact settings and display order. This is portable club configuration.
//
// Deliberately NOT transferred:
//  - CommitteeAssignment (who currently holds each role) — bound to real Member
//    rows, so it cannot travel in a member-free bundle; the target re-assigns
//    against its own members.
//  - CommitteeMember (the legacy standalone directory, "LegacyCommitteeMember"
//    in the admin UI) — a migration aid for clubs moving onto the role/assignment
//    model, not ongoing config, so it is not maintained through a transfer.
// See ADR-001 "committee scope".

const ROLE_FILE = "committee/roles.csv";

const ROLE_FIELDS = ["key", "name", "description", "contactEmail", "isActive", "sortOrder"] as const;

registerEntity({
  entity: "committee-role",
  category: "committee",
  tier: "key-strong",
  format: "csv",
  file: ROLE_FILE,
  naturalKey: ["key"],
  singleton: false,
  fields: [...ROLE_FIELDS],
});

const coerceInt = (v: string | undefined, d: number) =>
  Number.isFinite(Number.parseInt((v ?? "").trim(), 10)) ? Number.parseInt(v as string, 10) : d;
const coerceBool = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "true";
const readCsv = (files: Map<string, Uint8Array>, path: string) => {
  const b = files.get(path);
  return b ? parseCsv(strFromU8(b)).rows : [];
};

export const committeeExporter: CategoryExporter = {
  category: "committee",
  descriptors: [],
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const roles = await ctx.db.committeeRole.findMany({
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
      select: { key: true, name: true, description: true, contactEmail: true, isActive: true, sortOrder: true },
    });
    return [
      { path: ROLE_FILE, category: "committee", rowCount: roles.length, bytes: strToU8(serialiseCsv([...ROLE_FIELDS], roles)) },
    ];
  },
};

async function planCommittee(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const fingerprintParts: string[] = [];

  for (const raw of readCsv(ctx.files, ROLE_FILE)) {
    const key = raw.key ?? "";
    const current = await ctx.db.committeeRole.findUnique({
      where: { key },
      select: { key: true, name: true, description: true, contactEmail: true, isActive: true, sortOrder: true },
    });
    fingerprintParts.push(`committee-role:${key}:${current ? hashRow([...ROLE_FIELDS], current) : "absent"}`);
    items.push({ entity: "committee-role", key, action: current ? "update" : "create" });
  }

  return { items, warnings: [], fingerprintParts };
}

async function applyCommittee(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const raw of readCsv(ctx.files, ROLE_FILE)) {
    const key = raw.key ?? "";
    if (!key) { result.skipped += 1; continue; }
    const data = {
      name: raw.name ?? key,
      description: raw.description || null,
      contactEmail: raw.contactEmail || null,
      isActive: coerceBool(raw.isActive),
      sortOrder: coerceInt(raw.sortOrder, 0),
    };
    const existing = await ctx.tx.committeeRole.findUnique({ where: { key }, select: { id: true } });
    await ctx.tx.committeeRole.upsert({
      where: { key },
      create: { key, ...data },
      update: updateDataForMode(ctx.mode, raw, data),
    });
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  return result;
}

export const committeeImporter: CategoryImporter = {
  category: "committee",
  plan: planCommittee,
  apply: applyCommittee,
};
