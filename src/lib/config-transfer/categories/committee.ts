import { strToU8 } from "fflate";

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

// committee category: the CommitteeRole definitions that back the live
// (member-linked) committee page — President, Treasurer, etc., with their
// contact settings and display order. This is portable club configuration.
//
// Deliberately NOT transferred:
//  - CommitteeAssignment (who currently holds each role) — bound to real Member
//    rows, so it cannot travel in a member-free bundle; the target re-assigns
//    against its own members.
// The former standalone CommitteeMember directory (the migration aid ADR-001
// records as out of scope) has since been removed from the model, so there is
// no legacy table left to consider here.
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

interface RoleCurrent {
  id: string;
  key: string;
  name: string;
  description: string | null;
  contactEmail: string | null;
  isActive: boolean;
  sortOrder: number;
}

async function loadRoles(db: ReadDb): Promise<Map<string, RoleCurrent>> {
  const rows = await db.committeeRole.findMany({
    select: { id: true, key: true, name: true, description: true, contactEmail: true, isActive: true, sortOrder: true },
  });
  return new Map(rows.map((r) => [r.key, r]));
}

/** Validate + build one role row (mode-aware blanks for the typed cells). */
function parseRoleRow(
  index: number,
  raw: Record<string, string>,
  blankOk: boolean,
  errors: string[],
): { key: string; data: Record<string, unknown> } | null {
  const v = new RowValidator(ROLE_FILE, index, errors);
  const key = v.required("key", raw.key);
  const isActive =
    blankOk && nz(raw.isActive) === null ? true : v.bool("isActive", raw.isActive);
  const sortOrder =
    blankOk && nz(raw.sortOrder) === null ? 0 : v.int("sortOrder", raw.sortOrder);
  if (!v.ok) return null;
  return {
    key,
    data: {
      name: nz(raw.name) ?? key,
      description: nz(raw.description),
      contactEmail: nz(raw.contactEmail),
      isActive,
      sortOrder,
    },
  };
}

export const committeeExporter: CategoryExporter = {
  category: "committee",
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
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  const roles = await loadRoles(ctx.db);

  readCsvRows(ctx.files, ROLE_FILE).forEach((raw, i) => {
    const current = roles.get(raw.key?.trim() ?? "") ?? null;
    const parsed = parseRoleRow(i, raw, ctx.mode === "merge" && !!current, errors);
    if (!parsed) return;
    fingerprintParts.push(
      `committee-role:${parsed.key}:${current ? hashRow([...ROLE_FIELDS], current) : "absent"}`,
    );
    const write = updateDataForMode(ctx.mode, raw, parsed.data);
    const changed = changedFields(write, current);
    items.push({ entity: "committee-role", key: parsed.key, action: planActionFor(current, changed), changedFields: changed.length ? changed : undefined });
  });

  return { items, warnings: [], errors, fingerprintParts };
}

async function applyCommittee(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive only
  const roles = await loadRoles(ctx.tx);

  for (const [i, raw] of readCsvRows(ctx.files, ROLE_FILE).entries()) {
    const current = roles.get(raw.key?.trim() ?? "") ?? null;
    const parsed = parseRoleRow(i, raw, ctx.mode === "merge" && !!current, errors);
    if (!parsed) { result.skipped += 1; continue; }
    await applyRow({
      mode: ctx.mode,
      raw,
      data: parsed.data,
      current,
      create: (data) =>
        ctx.tx.committeeRole.create({ data: { key: parsed.key, ...(data as object) } as never }),
      update: (write) =>
        ctx.tx.committeeRole.update({ where: { id: current!.id }, data: write }),
      result,
    });
  }

  return result;
}

export const committeeImporter: CategoryImporter = {
  category: "committee",
  plan: planCommittee,
  apply: applyCommittee,
};
