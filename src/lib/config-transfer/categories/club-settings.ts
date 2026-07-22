import { strToU8, strFromU8 } from "fflate";
import { Prisma } from "@prisma/client";

import {
  DEFAULT_BED_ALLOCATION_SETTINGS,
  DEFAULT_BOOKING_DEFAULTS,
  DEFAULT_BOOKING_REQUEST_SETTINGS,
  DEFAULT_GROUP_DISCOUNT_SETTING,
  DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS,
  DEFAULT_MEMBERSHIP_CANCELLATION_SETTINGS,
  DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS,
  DEFAULT_MEMBERSHIP_NOMINATION_SETTINGS,
} from "@/config/club-settings-defaults";
import { DEFAULT_MEMBER_FIELDS_SETTINGS } from "@/config/member-fields";
import {
  CLUB_MODULE_SETTINGS_COLUMN_SELECT,
  DEFAULT_MODULE_SETTINGS,
} from "@/config/modules";
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
    select?: Record<string, boolean>;
  }): Promise<Record<string, unknown> | null>;
  upsert(args: {
    where: { id: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<unknown>;
}

interface SingletonSpec {
  entity: string;
  /** Prisma delegate name, e.g. "bookingDefaults". */
  delegate: string;
  fields: string[];
  optInFields?: string[];
  /**
   * Explicit Prisma `select` for reads of this singleton. Only set where a
   * shared select already exists (e.g. CLUB_MODULE_SETTINGS_COLUMN_SELECT) to
   * keep a retired-but-not-yet-dropped column out of the generated SQL — see
   * the doc comment on that constant. Other singletons keep a bare read.
   */
  select?: Record<string, boolean>;
  /**
   * The EFFECTIVE value of each field when the club has never saved this
   * singleton — i.e. what the app's own read path synthesises on a miss, which
   * is NOT always what a fresh Prisma row would default to. Exported in place
   * of the missing row (#2171) so the bundle carries the source club's
   * effective settings and an import reproduces them, instead of quietly
   * leaving the target's own values in place.
   *
   * Never write the values out here: import them from the same constant the
   * getter reads, so a changed default cannot leave the exporter behind.
   *
   * A field omitted from this record exports as `null`, which is only correct
   * for a NULLABLE OVERRIDE column whose real default lives in a lower fallback
   * layer. Returning `{}` is therefore a deliberate statement — see
   * `DEFAULTS_INTENTIONALLY_PARTIAL` — not an oversight.
   */
  defaults: () => Record<string, unknown>;
}

/**
 * The singletons whose `defaults()` legitimately covers none (or only some) of
 * their fields. Both are made entirely of nullable OVERRIDE columns resolved
 * through the deployment's `config/club.json` / environment fallback chain, so
 * "never saved" means "no override" — exactly what their admin GETs synthesise
 * — and the fallback values belong to the install rather than to the club's
 * portable configuration. Guarded by a test so a genuinely under-specified new
 * singleton cannot join them silently.
 */
export const DEFAULTS_INTENTIONALLY_PARTIAL = new Set([
  "club-identity-settings",
  "email-message-setting",
]);

export const SINGLETONS: SingletonSpec[] = [
  {
    entity: "club-module-settings",
    delegate: "clubModuleSettings",
    fields: [
      "kiosk", "chores", "financeDashboard", "waitlist", "xeroIntegration",
      "bedAllocation", "internetBankingPayments", "addressAutocomplete",
      "groupBookings", "lockers", "induction", "workParties", "promoCodes",
      "hutLeaders", "communications", "skifieldConditions",
      "twoFactor", "analytics", "lobbyDisplay",
    ],
    select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
    defaults: () => DEFAULT_MODULE_SETTINGS,
  },
  {
    entity: "booking-defaults",
    delegate: "bookingDefaults",
    fields: ["nonMemberHoldEnabled", "nonMemberHoldDays", "waitlistCrossLodgeOrder"],
    defaults: () => DEFAULT_BOOKING_DEFAULTS,
  },
  {
    entity: "member-fields-settings",
    delegate: "memberFieldsSettings",
    fields: ["showTitle", "showGender", "showOccupation"],
    defaults: () => DEFAULT_MEMBER_FIELDS_SETTINGS,
  },
  {
    entity: "bed-allocation-settings",
    delegate: "bedAllocationSettings",
    fields: ["autoAllocationEnabled"],
    defaults: () => DEFAULT_BED_ALLOCATION_SETTINGS,
  },
  {
    entity: "booking-request-settings",
    delegate: "bookingRequestSettings",
    fields: [
      "showPricingToNonMembers", "quoteResponseTtlDays", "quoteReminderLeadDays",
      "attendeeConfirmationLeadDays", "attendeeConfirmationReminderDays",
    ],
    defaults: () => DEFAULT_BOOKING_REQUEST_SETTINGS,
  },
  {
    entity: "internet-banking-payment-settings",
    delegate: "internetBankingPaymentSettings",
    fields: ["holdBedSlots", "holdDays", "minimumDaysBeforeCheckIn"],
    defaults: () => DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS,
  },
  {
    // DB-first club identity (E3 #1929). Singleton row id="default"; all fields
    // nullable and served through the runtime fallback chain, so exporting/
    // importing them moves only the admin-set overrides.
    entity: "club-identity-settings",
    delegate: "clubIdentitySettings",
    fields: ["name", "shortName", "hutLeaderLabel", "facebookUrl"],
    // No override saved = every column null, which is what the admin GET
    // synthesises. See DEFAULTS_INTENTIONALLY_PARTIAL.
    defaults: () => ({}),
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
    // As club-identity-settings: these columns are nullable overrides on top of
    // the install's own club.json/env identity, and that identity is not
    // portable. See DEFAULTS_INTENTIONALLY_PARTIAL.
    defaults: () => ({}),
  },
  {
    entity: "group-discount-setting",
    delegate: "groupDiscountSetting",
    fields: ["minGroupSize", "summerOnly", "enabled"],
    defaults: () => DEFAULT_GROUP_DISCOUNT_SETTING,
  },
  {
    entity: "membership-nomination-settings",
    delegate: "membershipNominationSettings",
    fields: [
      "gateEnabled", "minimumMembershipMonths", "minimumNights",
      "requiredSignOffs", "gateEffectiveFrom",
    ],
    defaults: () => DEFAULT_MEMBERSHIP_NOMINATION_SETTINGS,
  },
  {
    entity: "membership-lockout-settings",
    delegate: "membershipLockoutSettings",
    fields: ["enabled", "financialYearEndMonthOverride", "textFallbackEnabled"],
    defaults: () => DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS,
  },
  {
    entity: "membership-cancellation-setting",
    delegate: "membershipCancellationSetting",
    fields: ["warningText", "rejoinProcessText", "xeroArchiveContactsOnCancellation"],
    defaults: () => DEFAULT_MEMBERSHIP_CANCELLATION_SETTINGS,
  },
];

function fileFor(entity: string): string {
  return `club-settings/${entity}.json`;
}

/**
 * True when the incoming file carries no allowlisted value at all — every field
 * present is `null` (or none is present). In practice this is only the
 * `DEFAULTS_INTENTIONALLY_PARTIAL` pair exported from a club that never saved
 * an override; every other singleton exports concrete defaults.
 *
 * Such a file must NOT create a row on a target that has none (#2171 review):
 * `clubIdentitySelfHealStep.isPresent` (`src/lib/config-self-heal.ts`) keys
 * purely on the `ClubIdentitySettings` row EXISTING, and the whole self-heal
 * runner is skipped while `clubConfigSource !== "primary"` on the promise that
 * it repairs itself on the next boot with a valid `config/club.json`. An import
 * onto a SAFE_DEFAULT install would otherwise plant an all-null row that
 * permanently satisfies that presence check, so identity would never be healed
 * from the file — and `clubIdentityName` in the setup snapshot would stay null
 * forever. Skipping restores the exact pre-#2171 behaviour for the no-row case
 * at no cost: an all-null file carries nothing to write.
 */
function carriesNoValue(
  spec: SingletonSpec,
  incoming: Record<string, unknown>,
): boolean {
  return spec.fields.every((f) => !(f in incoming) || incoming[f] === null);
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
        select: spec.select,
      });
      // #2171: a club that has never SAVED a singleton is not a club with no
      // settings — every read site synthesises defaults on a miss. Export those
      // effective values in place of the missing row so the bundle carries what
      // the source club actually runs on, and an import reproduces it instead
      // of silently leaving the target's own row in place.
      //
      // The cost, accepted by the owner on #2171: a bundle no longer
      // distinguishes "saved these values" from "never saved anything", and
      // importing one MATERIALISES the row in the target. That is visible in
      // the FOUR setup-checklist signals that key on row existence: three
      // booleans in the snapshot (bookingDefaultsConfigured,
      // groupDiscountConfigured, membershipCancellationSettingsConfigured,
      // `src/lib/setup-readiness-db.ts`) plus the Module Controls step, which
      // reads `Boolean(db.adminModuleSettings)` directly in
      // `src/lib/setup-readiness.ts` (`required: false`, so it downgrades a
      // warning rather than gating). See docs/config-transfer.
      //
      // The one exception is a file whose every value is null — see
      // carriesNoValue: it creates no row, so it cannot flip any of them.
      const fields = exportFields(spec, ctx.includeDoorCodes);
      entries.push({
        path: fileFor(spec.entity),
        category: "club-settings",
        rowCount: 1,
        bytes: strToU8(
          JSON.stringify(project(row ?? spec.defaults(), fields), null, 2),
        ),
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
      select: spec.select,
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
    // Mirror apply's no-row/no-value skip so the dry-run cannot promise a
    // "create" the apply will decline to make.
    const noOp = !current && carriesNoValue(spec, incoming);
    items.push({
      entity: spec.entity,
      key: "default",
      action: noOp ? "unchanged" : planActionFor(current, changed),
      changedFields: noOp || changed.length === 0 ? undefined : changed,
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
    const existing = await delegate.findUnique({
      where: { id: "default" },
      select: spec.select,
    });
    if (!existing) {
      // An all-null file plants nothing but a row, and that row would defeat
      // the boot-time identity self-heal for good — see carriesNoValue.
      if (carriesNoValue(spec, incoming)) {
        result.unchanged += 1;
        continue;
      }
      await delegate.upsert({
        where: { id: "default" },
        create: { id: "default", ...data },
        update: {},
        select: spec.select,
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
      select: spec.select,
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
