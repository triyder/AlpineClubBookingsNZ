import { strToU8, strFromU8 } from "fflate";
import { Prisma } from "@prisma/client";

import type { BundleEntry } from "../bundle";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
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
  type TxDb,
} from "../import-types";

// club-settings category: the club-wide singleton settings rows (id="default"),
// serialised one JSON file each. Generic (spec-driven) so adding a settings row
// is a one-line change. See ADR-001/002.

/** Minimal delegate shape for a singleton settings model. */
interface SingletonDelegate {
  findUnique(args: {
    where: { id: string };
  }): Promise<Record<string, unknown> | null>;
  upsert(args: {
    where: { id: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
}

interface SingletonSpec {
  entity: string;
  /** Prisma delegate name, e.g. "bookingDefaults". */
  delegate: string;
  fields: string[];
  optInFields?: string[];
}

export const SINGLETONS: SingletonSpec[] = [
  {
    entity: "club-module-settings",
    delegate: "clubModuleSettings",
    fields: [
      "kiosk", "chores", "financeDashboard", "waitlist", "xeroIntegration",
      "bedAllocation", "internetBankingPayments", "addressAutocomplete",
      "groupBookings", "lockers", "induction", "workParties", "promoCodes",
      "hutLeaders", "communications", "skifieldConditions", "multiLodge",
      "twoFactor", "analytics", "lobbyDisplay",
    ],
  },
  {
    entity: "booking-defaults",
    delegate: "bookingDefaults",
    fields: ["nonMemberHoldEnabled", "nonMemberHoldDays", "waitlistCrossLodgeOrder"],
  },
  {
    entity: "member-fields-settings",
    delegate: "memberFieldsSettings",
    fields: ["showTitle", "showGender", "showOccupation"],
  },
  {
    entity: "bed-allocation-settings",
    delegate: "bedAllocationSettings",
    fields: ["autoAllocationEnabled"],
  },
  {
    entity: "booking-request-settings",
    delegate: "bookingRequestSettings",
    fields: [
      "showPricingToNonMembers", "quoteResponseTtlDays", "quoteReminderLeadDays",
      "attendeeConfirmationLeadDays", "attendeeConfirmationReminderDays",
    ],
  },
  {
    entity: "internet-banking-payment-settings",
    delegate: "internetBankingPaymentSettings",
    fields: ["holdBedSlots", "holdDays", "minimumDaysBeforeCheckIn"],
  },
  {
    entity: "email-message-setting",
    delegate: "emailMessageSetting",
    // lodgeName / lodgeTravelNote / doorCode were all dropped upstream (fork
    // #15, PR #1663): lodge identity (incl. the lodge door code) now resolves
    // from the Lodge row, so none are columns here — do not export/import them.
    // (The lodge's door code travels in lodge.json, opt-in.)
    fields: [
      "clubName", "bookingsName", "emailFromName", "supportEmail",
      "contactEmail", "publicUrl",
    ],
  },
  {
    entity: "group-discount-setting",
    delegate: "groupDiscountSetting",
    fields: ["minGroupSize", "summerOnly", "enabled"],
  },
  {
    entity: "membership-nomination-settings",
    delegate: "membershipNominationSettings",
    fields: [
      "gateEnabled", "minimumMembershipMonths", "minimumNights",
      "requiredSignOffs", "gateEffectiveFrom",
    ],
  },
  {
    entity: "membership-lockout-settings",
    delegate: "membershipLockoutSettings",
    fields: ["enabled", "financialYearEndMonthOverride", "textFallbackEnabled"],
  },
  {
    entity: "membership-cancellation-setting",
    delegate: "membershipCancellationSetting",
    fields: ["warningText", "rejoinProcessText", "xeroArchiveContactsOnCancellation"],
  },
];

function fileFor(entity: string): string {
  return `club-settings/${entity}.json`;
}

for (const s of SINGLETONS) {
  registerEntity({
    entity: s.entity,
    category: "club-settings",
    tier: "key-strong",
    format: "json",
    file: fileFor(s.entity),
    naturalKey: [],
    singleton: true,
    fields: s.fields,
    optInFields: s.optInFields,
  });
}

/**
 * Parse a singleton JSON file and type-check every allowlisted field against
 * the REAL Prisma model column types (via dmmf) — a hand-edited value of the
 * wrong shape fails the dry-run as an error instead of a write-time Prisma
 * exception mid-transaction. Returns null (with errors pushed) on failure.
 */
function parseSingleton(
  spec: SingletonSpec,
  bytes: Uint8Array,
  errors: string[],
): Record<string, unknown> | null {
  const file = fileFor(spec.entity);
  let incoming: unknown;
  try {
    incoming = JSON.parse(strFromU8(bytes));
  } catch (error) {
    errors.push(
      `${file}: not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
    );
    return null;
  }
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    errors.push(`${file}: must be a JSON object`);
    return null;
  }
  const record = incoming as Record<string, unknown>;
  const modelName = spec.delegate[0].toUpperCase() + spec.delegate.slice(1);
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  let ok = true;
  for (const field of spec.fields) {
    if (!(field in record)) continue;
    const value = record[field];
    const column = model?.fields.find((f) => f.name === field);
    if (!column) continue; // guarded separately by the schema-drift test
    if (value === null) {
      if (column.isRequired) {
        errors.push(`${file}: ${field} — null is not allowed (required setting)`);
        ok = false;
      }
      continue;
    }
    const fails =
      (column.type === "Boolean" && typeof value !== "boolean") ||
      (column.type === "Int" && (typeof value !== "number" || !Number.isInteger(value))) ||
      (column.type === "String" && typeof value !== "string") ||
      (column.type === "DateTime" &&
        (typeof value !== "string" || Number.isNaN(new Date(value).getTime())));
    if (fails) {
      errors.push(
        `${file}: ${field} — ${JSON.stringify(value)} is not a valid ${column.type}`,
      );
      ok = false;
    }
  }
  return ok ? record : null;
}

function delegateOf(db: ReadDb | TxDb, name: string): SingletonDelegate {
  return (db as unknown as Record<string, SingletonDelegate>)[name];
}

/** Fields to serialise, dropping opt-in fields unless the admin opted in. */
function exportFields(spec: SingletonSpec, includeOptIn: boolean): string[] {
  if (includeOptIn) return spec.fields;
  const optIn = new Set(spec.optInFields ?? []);
  return spec.fields.filter((f) => !optIn.has(f));
}

function project(
  row: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = row[f] ?? null;
  return out;
}

export const clubSettingsExporter: CategoryExporter = {
  category: "club-settings",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const entries: BundleEntry[] = [];
    for (const spec of SINGLETONS) {
      const row = await delegateOf(ctx.db, spec.delegate).findUnique({
        where: { id: "default" },
      });
      if (!row) continue;
      const fields = exportFields(spec, ctx.includeDoorCodes);
      entries.push({
        path: fileFor(spec.entity),
        category: "club-settings",
        rowCount: 1,
        bytes: strToU8(JSON.stringify(project(row, fields), null, 2)),
      });
    }
    return entries;
  },
};

async function planClubSettings(
  ctx: PlanContext,
): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  for (const spec of SINGLETONS) {
    const bytes = ctx.files.get(fileFor(spec.entity));
    if (!bytes) continue;
    const incoming = parseSingleton(spec, bytes, errors);
    if (!incoming) continue;
    const current = await delegateOf(ctx.db, spec.delegate).findUnique({
      where: { id: "default" },
    });
    const currentHash = current
      ? hashRow(spec.fields, current)
      : "absent";
    fingerprintParts.push(`${spec.entity}:default:${currentHash}`);
    // Mirror apply's write-data (present allowlisted fields, mode-filtered) and
    // diff it against the current row so the dry-run reflects the chosen mode.
    const data: Record<string, unknown> = {};
    for (const f of spec.fields) if (f in incoming) data[f] = incoming[f];
    const writeData = updateDataForMode(ctx.mode, incoming, data);
    const changed = changedFields(writeData, current);
    items.push({
      entity: spec.entity,
      key: "default",
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }
  return { items, warnings: [], errors, fingerprintParts };
}

async function applyClubSettings(
  ctx: ApplyContext,
): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive only
  for (const spec of SINGLETONS) {
    const bytes = ctx.files.get(fileFor(spec.entity));
    if (!bytes) continue;
    const incoming = parseSingleton(spec, bytes, errors);
    if (!incoming) { result.skipped += 1; continue; }
    // Replace-present: only allowlisted fields actually present in the bundle.
    const data: Record<string, unknown> = {};
    for (const f of spec.fields) {
      if (f in incoming) data[f] = incoming[f];
    }
    const delegate = delegateOf(ctx.tx, spec.delegate);
    const existing = await delegate.findUnique({ where: { id: "default" } });
    if (!existing) {
      await delegate.upsert({
        where: { id: "default" },
        create: { id: "default", ...data },
        update: {},
      });
      result.created += 1;
      continue;
    }
    const write = updateDataForMode(ctx.mode, incoming, data);
    const changed = changedFields(write, existing);
    if (changed.length === 0) {
      result.unchanged += 1;
      continue;
    }
    await delegate.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: write,
    });
    result.updated += 1;
  }
  return result;
}

export const clubSettingsImporter: CategoryImporter = {
  category: "club-settings",
  plan: planClubSettings,
  apply: applyClubSettings,
};
