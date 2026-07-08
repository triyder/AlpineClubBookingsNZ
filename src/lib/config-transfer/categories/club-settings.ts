import { strToU8, strFromU8 } from "fflate";

import type { BundleEntry } from "../bundle";
import { registerEntity, type EntityDescriptor } from "../registry";
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

const SINGLETONS: SingletonSpec[] = [
  {
    entity: "club-module-settings",
    delegate: "clubModuleSettings",
    fields: [
      "kiosk", "chores", "financeDashboard", "waitlist", "xeroIntegration",
      "bedAllocation", "internetBankingPayments", "addressAutocomplete",
      "groupBookings", "lockers", "induction", "workParties", "promoCodes",
      "hutLeaders", "communications", "skifieldConditions", "multiLodge",
      "twoFactor", "analytics",
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
    fields: [
      "clubName", "bookingsName", "lodgeName", "emailFromName", "supportEmail",
      "contactEmail", "publicUrl", "lodgeTravelNote", "doorCode",
    ],
    optInFields: ["doorCode"],
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

export const clubSettingsDescriptors: EntityDescriptor[] = SINGLETONS.map((s) =>
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
  }),
);

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
  descriptors: clubSettingsDescriptors,
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
  const fingerprintParts: string[] = [];
  for (const spec of SINGLETONS) {
    const bytes = ctx.files.get(fileFor(spec.entity));
    if (!bytes) continue;
    const incoming = JSON.parse(strFromU8(bytes)) as Record<string, unknown>;
    const current = await delegateOf(ctx.db, spec.delegate).findUnique({
      where: { id: "default" },
    });
    const currentHash = current
      ? hashRow(spec.fields, current)
      : "absent";
    fingerprintParts.push(`${spec.entity}:default:${currentHash}`);
    if (!current) {
      items.push({ entity: spec.entity, key: "default", action: "create" });
      continue;
    }
    const changed = Object.keys(incoming).filter(
      (f) => spec.fields.includes(f) &&
        String(current[f] ?? "") !== String(incoming[f] ?? ""),
    );
    items.push(
      changed.length
        ? { entity: spec.entity, key: "default", action: "update", changedFields: changed }
        : { entity: spec.entity, key: "default", action: "unchanged" },
    );
  }
  return { items, warnings: [], fingerprintParts };
}

async function applyClubSettings(
  ctx: ApplyContext,
): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  for (const spec of SINGLETONS) {
    const bytes = ctx.files.get(fileFor(spec.entity));
    if (!bytes) continue;
    const incoming = JSON.parse(strFromU8(bytes)) as Record<string, unknown>;
    // Replace-present: only allowlisted fields actually present in the bundle.
    const data: Record<string, unknown> = {};
    for (const f of spec.fields) {
      if (f in incoming) data[f] = incoming[f];
    }
    const delegate = delegateOf(ctx.tx, spec.delegate);
    const existing = await delegate.findUnique({ where: { id: "default" } });
    await delegate.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: updateDataForMode(ctx.mode, incoming, data),
    });
    if (existing) result.updated += 1;
    else result.created += 1;
  }
  return result;
}

export const clubSettingsImporter: CategoryImporter = {
  category: "club-settings",
  plan: planClubSettings,
  apply: applyClubSettings,
};
