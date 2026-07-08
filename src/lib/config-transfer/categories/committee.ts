import { strToU8, strFromU8 } from "fflate";

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

// committee category: the public committee page's role definitions plus the
// legacy standalone committee members. The newer member-linked
// CommitteeAssignment style is deliberately out of scope (members are excluded),
// so a transfer supports the migration between the two styles. See ADR-001.

const ROLE_FILE = "committee/roles.csv";
const MEMBER_FILE = "committee/members.csv";

const ROLE_FIELDS = ["key", "name", "description", "contactEmail", "isActive", "sortOrder"] as const;
const MEMBER_FIELDS = ["role", "name", "phone", "email", "contactKey", "description", "sortOrder", "active"] as const;

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
registerEntity({
  entity: "committee-member",
  category: "committee",
  tier: "key-weak",
  format: "csv",
  file: MEMBER_FILE,
  naturalKey: ["role", "name"],
  singleton: false,
  fields: [...MEMBER_FIELDS],
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
    const members = await ctx.db.committeeMember.findMany({
      orderBy: [{ sortOrder: "asc" }, { role: "asc" }],
      select: { role: true, name: true, phone: true, email: true, contactKey: true, description: true, sortOrder: true, active: true },
    });
    return [
      { path: ROLE_FILE, category: "committee", rowCount: roles.length, bytes: strToU8(serialiseCsv([...ROLE_FIELDS], roles)) },
      { path: MEMBER_FILE, category: "committee", rowCount: members.length, bytes: strToU8(serialiseCsv([...MEMBER_FIELDS], members)) },
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

  for (const raw of readCsv(ctx.files, MEMBER_FILE)) {
    const key = `${raw.role}/${raw.name}`;
    const current = await ctx.db.committeeMember.findFirst({
      where: { role: raw.role ?? "", name: raw.name ?? "" },
      select: { id: true },
    });
    fingerprintParts.push(`committee-member:${key}:${current ? "present" : "absent"}`);
    items.push({ entity: "committee-member", key, action: current ? "update" : "create" });
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
      contactEmail: raw.email || raw.contactEmail || null,
      isActive: coerceBool(raw.isActive),
      sortOrder: coerceInt(raw.sortOrder, 0),
    };
    const existing = await ctx.tx.committeeRole.findUnique({ where: { key }, select: { id: true } });
    await ctx.tx.committeeRole.upsert({
      where: { key },
      create: { key, ...data },
      update: data,
    });
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  for (const raw of readCsv(ctx.files, MEMBER_FILE)) {
    const role = raw.role ?? "";
    const name = raw.name ?? "";
    if (!role || !name) { result.skipped += 1; continue; }
    const data = {
      phone: raw.phone ?? "",
      email: raw.email || null,
      contactKey: raw.contactKey || null,
      description: raw.description ?? "",
      sortOrder: coerceInt(raw.sortOrder, 0),
      active: coerceBool(raw.active),
    };
    const existing = await ctx.tx.committeeMember.findFirst({
      where: { role, name },
      select: { id: true },
    });
    if (existing) {
      await ctx.tx.committeeMember.update({ where: { id: existing.id }, data });
      result.updated += 1;
    } else {
      await ctx.tx.committeeMember.create({ data: { role, name, ...data } });
      result.created += 1;
    }
  }

  return result;
}

export const committeeImporter: CategoryImporter = {
  category: "committee",
  plan: planCommittee,
  apply: applyCommittee,
};
