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

// membership-fees category (#1941, follow-up to #1931/#1932): the first-class
// transfer of the MEMBERSHIP FEE SCHEDULES — joining fees (JoiningFee, #1931/E5)
// and annual membership fees with their invoice-line components
// (MembershipAnnualFee + MembershipAnnualFeeComponent, #1932/E6). Modelled on
// the season-rates precedent (lodge-config): flat CSVs with an explicit natural
// key, deterministic byte-stable export ordering, and upsert-only apply that
// never deletes.
//
//   membership-fees/joining-fees.csv
//     membershipTypeKey, ageTier, effectiveFrom, effectiveTo, amountCents
//     natural key: membershipTypeKey x ageTier x effectiveFrom (a blank ageTier
//     is a flat-fee type's single NULL-tier window, e.g. the built-in Family
//     type). Matches JoiningFee @@unique([membershipTypeId, ageTier,
//     effectiveFrom]).
//   membership-fees/annual-fees.csv
//     membershipTypeKey, effectiveFrom, effectiveTo, amountCents, billingBasis,
//     prorationRule
//     natural key: membershipTypeKey x effectiveFrom. Matches
//     MembershipAnnualFee @@unique([membershipTypeId, effectiveFrom]).
//   membership-fees/annual-fee-components.csv
//     membershipTypeKey, effectiveFrom, label, amountCents, prorate,
//     xeroAccountCode, xeroItemCode, sortOrder
//     natural key: (parent annual fee = membershipTypeKey x effectiveFrom) x
//     label. Each component is one Xero invoice line (#1932, E6).
//
// Money stays in integer cents throughout. Referenced membership types must
// already exist on the target (by key) — membership types themselves are not
// transferred by config transfer (they are seeded/managed on the Membership
// Types page); an unknown key is a blocking row error, exactly like the
// season-rates and item-code categories.
//
// Component invariant (#1932, E6), validated at plan time so a malformed bundle
// never reaches a write: a NO_INVOICE annual fee is a zero total with NO
// components; every invoiceable fee carries >=1 component whose amounts sum
// EXACTLY to the fee total. Because the fee total stays authoritative, an
// annual-fee row must always travel with its full component set (as the export
// always emits them) — the sum is checked against the bundle's own amount.
//
// PRECEDENCE over the #1931 legacy materialisation: when a bundle carries this
// category's joining-fees.csv, the fee amounts are authoritative here, so the
// xero-config legacy item-code-amount fan-out (which invents JoiningFee windows
// from a pre-#1931 bundle's dead amountCents column) must NOT also run — it
// would duplicate or skew the schedule. Old-format bundles (no joining-fees.csv)
// keep the legacy path per the E13 compat window. See
// bundleCarriesJoiningFeeSchedule (consumed by xero-config).

const JOINING_FEES_FILE = "membership-fees/joining-fees.csv";
const ANNUAL_FEES_FILE = "membership-fees/annual-fees.csv";
const ANNUAL_FEE_COMPONENTS_FILE = "membership-fees/annual-fee-components.csv";

const JOINING_FEE_FIELDS = [
  "membershipTypeKey",
  "ageTier",
  "effectiveFrom",
  "effectiveTo",
  "amountCents",
] as const;
const ANNUAL_FEE_FIELDS = [
  "membershipTypeKey",
  "effectiveFrom",
  "effectiveTo",
  "amountCents",
  "billingBasis",
  "prorationRule",
] as const;
const COMPONENT_FIELDS = [
  "membershipTypeKey",
  "effectiveFrom",
  "label",
  "amountCents",
  "prorate",
  "xeroAccountCode",
  "xeroItemCode",
  "sortOrder",
] as const;

const NO_INVOICE = "NO_INVOICE";
const DEFAULT_PRORATION_RULE = "NONE";

/**
 * True when a bundle carries the first-class joining-fee schedule (#1941). It
 * SUPERSEDES the #1931 legacy joining-fee materialisation in xero-config: a
 * new-format bundle sets JoiningFee amounts directly here, so the legacy
 * item-code-amount fan-out must not also run. Consumed by xero-config.
 */
export function bundleCarriesJoiningFeeSchedule(
  files: Map<string, Uint8Array>,
): boolean {
  return files.has(JOINING_FEES_FILE);
}

registerEntity({
  entity: "joining-fee",
  category: "membership-fees",
  tier: "key-strong",
  format: "csv",
  file: JOINING_FEES_FILE,
  naturalKey: ["membershipTypeKey", "ageTier", "effectiveFrom"],
  singleton: false,
  fields: [...JOINING_FEE_FIELDS],
});
registerEntity({
  entity: "annual-fee",
  category: "membership-fees",
  tier: "key-strong",
  format: "csv",
  file: ANNUAL_FEES_FILE,
  naturalKey: ["membershipTypeKey", "effectiveFrom"],
  singleton: false,
  fields: [...ANNUAL_FEE_FIELDS],
});
registerEntity({
  entity: "annual-fee-component",
  category: "membership-fees",
  // key-weak: MembershipAnnualFeeComponent has no DB unique on (fee, label); we
  // match by label within a parent fee (like induction's items), upsert-only.
  tier: "key-weak",
  format: "csv",
  file: ANNUAL_FEE_COMPONENTS_FILE,
  naturalKey: ["membershipTypeKey", "effectiveFrom", "label"],
  singleton: false,
  fields: [...COMPONENT_FIELDS],
});

/** date-only (@db.Date): serialise as YYYY-MM-DD. */
function toDateStr(value: Date | null | undefined): string {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

/** Parent-fee key for a component/fee: membershipTypeKey + effective-from. */
function parentKey(membershipTypeKey: string, effectiveFrom: Date): string {
  return `${membershipTypeKey}/${toDateStr(effectiveFrom)}`;
}

// ---- Batched current-state loading (shared by plan + apply) -----------------

interface JoiningFeeCurrent {
  id: string;
  amountCents: number;
  effectiveTo: Date | null;
}
interface AnnualFeeCurrent {
  id: string;
  amountCents: number;
  billingBasis: string;
  prorationRule: string;
  effectiveTo: Date | null;
}
interface ComponentCurrent {
  id: string;
  amountCents: number;
  prorate: boolean;
  xeroAccountCode: string | null;
  xeroItemCode: string | null;
  sortOrder: number;
}
interface FeesBatch {
  membershipTypeIdByKey: Map<string, string>;
  membershipTypeKeys: Set<string>;
  /** by `${key}/${ageTier??""}/${fromISO}` */
  joiningFees: Map<string, JoiningFeeCurrent>;
  /** by `${key}/${fromISO}` */
  annualFees: Map<string, AnnualFeeCurrent>;
  /** by `${key}/${fromISO}/${label}` */
  components: Map<string, ComponentCurrent>;
}

async function loadFeesBatch(db: ReadDb): Promise<FeesBatch> {
  const [types, joiningRows, annualRows] = await Promise.all([
    db.membershipType.findMany({ select: { id: true, key: true } }),
    db.joiningFee.findMany({
      select: {
        id: true,
        ageTier: true,
        effectiveFrom: true,
        effectiveTo: true,
        amountCents: true,
        membershipType: { select: { key: true } },
      },
    }),
    db.membershipAnnualFee.findMany({
      select: {
        id: true,
        effectiveFrom: true,
        effectiveTo: true,
        amountCents: true,
        billingBasis: true,
        prorationRule: true,
        membershipType: { select: { key: true } },
        components: {
          select: {
            id: true,
            label: true,
            amountCents: true,
            prorate: true,
            xeroAccountCode: true,
            xeroItemCode: true,
            sortOrder: true,
          },
        },
      },
    }),
  ]);

  const membershipTypeIdByKey = new Map(types.map((t) => [t.key, t.id]));
  const joiningFees = new Map<string, JoiningFeeCurrent>();
  for (const r of joiningRows) {
    const key = `${r.membershipType.key}/${r.ageTier ?? ""}/${toDateStr(r.effectiveFrom)}`;
    joiningFees.set(key, {
      id: r.id,
      amountCents: r.amountCents,
      effectiveTo: r.effectiveTo,
    });
  }
  const annualFees = new Map<string, AnnualFeeCurrent>();
  const components = new Map<string, ComponentCurrent>();
  for (const fee of annualRows) {
    const pk = parentKey(fee.membershipType.key, fee.effectiveFrom);
    annualFees.set(pk, {
      id: fee.id,
      amountCents: fee.amountCents,
      billingBasis: fee.billingBasis,
      prorationRule: fee.prorationRule,
      effectiveTo: fee.effectiveTo,
    });
    for (const c of fee.components) {
      components.set(`${pk}/${c.label}`, {
        id: c.id,
        amountCents: c.amountCents,
        prorate: c.prorate,
        xeroAccountCode: c.xeroAccountCode,
        xeroItemCode: c.xeroItemCode,
        sortOrder: c.sortOrder,
      });
    }
  }

  return {
    membershipTypeIdByKey,
    membershipTypeKeys: new Set(types.map((t) => t.key)),
    joiningFees,
    annualFees,
    components,
  };
}

// ---- Export ----------------------------------------------------------------

export const membershipFeesExporter: CategoryExporter = {
  category: "membership-fees",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const [joiningFees, annualFees] = await Promise.all([
      ctx.db.joiningFee.findMany({
        select: {
          ageTier: true,
          effectiveFrom: true,
          effectiveTo: true,
          amountCents: true,
          membershipType: { select: { key: true } },
        },
      }),
      ctx.db.membershipAnnualFee.findMany({
        select: {
          effectiveFrom: true,
          effectiveTo: true,
          amountCents: true,
          billingBasis: true,
          prorationRule: true,
          membershipType: { select: { key: true } },
          components: {
            select: {
              label: true,
              amountCents: true,
              prorate: true,
              xeroAccountCode: true,
              xeroItemCode: true,
              sortOrder: true,
            },
          },
        },
      }),
    ]);

    // Nothing to carry → emit nothing (the category is simply absent, like
    // xero-config with no mappings).
    if (joiningFees.length === 0 && annualFees.length === 0) return [];

    // Deterministic, install-independent ordering (never DB ids) so
    // export→import→export is byte-stable.
    const joiningRows = joiningFees
      .map((f) => ({
        membershipTypeKey: f.membershipType.key,
        ageTier: f.ageTier ?? "",
        effectiveFrom: toDateStr(f.effectiveFrom),
        effectiveTo: toDateStr(f.effectiveTo),
        amountCents: f.amountCents,
      }))
      .sort(
        (a, b) =>
          a.membershipTypeKey.localeCompare(b.membershipTypeKey) ||
          a.ageTier.localeCompare(b.ageTier) ||
          a.effectiveFrom.localeCompare(b.effectiveFrom),
      );

    const sortedAnnual = [...annualFees].sort(
      (a, b) =>
        a.membershipType.key.localeCompare(b.membershipType.key) ||
        toDateStr(a.effectiveFrom).localeCompare(toDateStr(b.effectiveFrom)),
    );
    const annualRows: Record<string, unknown>[] = [];
    const componentRows: Record<string, unknown>[] = [];
    for (const fee of sortedAnnual) {
      annualRows.push({
        membershipTypeKey: fee.membershipType.key,
        effectiveFrom: toDateStr(fee.effectiveFrom),
        effectiveTo: toDateStr(fee.effectiveTo),
        amountCents: fee.amountCents,
        billingBasis: fee.billingBasis,
        prorationRule: fee.prorationRule,
      });
      const comps = [...fee.components].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
      );
      for (const c of comps) {
        componentRows.push({
          membershipTypeKey: fee.membershipType.key,
          effectiveFrom: toDateStr(fee.effectiveFrom),
          label: c.label,
          amountCents: c.amountCents,
          prorate: c.prorate,
          xeroAccountCode: c.xeroAccountCode,
          xeroItemCode: c.xeroItemCode,
          sortOrder: c.sortOrder,
        });
      }
    }

    // Always emit the full trio (header-only when empty) so the presence of the
    // category is self-describing AND joining-fees.csv exists whenever the
    // category is present — that presence is what supersedes the legacy
    // xero-config materialisation.
    return [
      {
        path: JOINING_FEES_FILE,
        category: "membership-fees",
        rowCount: joiningRows.length,
        bytes: strToU8(serialiseCsv([...JOINING_FEE_FIELDS], joiningRows)),
      },
      {
        path: ANNUAL_FEES_FILE,
        category: "membership-fees",
        rowCount: annualRows.length,
        bytes: strToU8(serialiseCsv([...ANNUAL_FEE_FIELDS], annualRows)),
      },
      {
        path: ANNUAL_FEE_COMPONENTS_FILE,
        category: "membership-fees",
        rowCount: componentRows.length,
        bytes: strToU8(serialiseCsv([...COMPONENT_FIELDS], componentRows)),
      },
    ];
  },
};

// ---- Row parsing + strict validation (shared by plan + apply) ---------------

interface ParsedJoiningFee {
  raw: Record<string, string>;
  membershipTypeKey: string;
  ageTier: string | null;
  effectiveFrom: Date;
  key: string;
  data: { amountCents: number; effectiveTo: Date | null };
}
interface ParsedAnnualFee {
  raw: Record<string, string>;
  membershipTypeKey: string;
  effectiveFrom: Date;
  key: string;
  parentKey: string;
  billingBasis: string;
  data: {
    amountCents: number;
    effectiveTo: Date | null;
    billingBasis: string;
    prorationRule: string;
  };
}
interface ParsedComponent {
  raw: Record<string, string>;
  membershipTypeKey: string;
  effectiveFrom: Date;
  label: string;
  key: string;
  parentKey: string;
  data: {
    amountCents: number;
    prorate: boolean;
    xeroAccountCode: string | null;
    xeroItemCode: string | null;
    sortOrder: number;
  };
}
interface ParsedFees {
  joiningFees: ParsedJoiningFee[];
  annualFees: ParsedAnnualFee[];
  components: ParsedComponent[];
}

function parseMembershipFees(
  files: Map<string, Uint8Array>,
  batch: FeesBatch,
  errors: string[],
): ParsedFees {
  const out: ParsedFees = { joiningFees: [], annualFees: [], components: [] };

  readCsvRows(files, JOINING_FEES_FILE).forEach((raw, i) => {
    const v = new RowValidator(JOINING_FEES_FILE, i, errors);
    const membershipTypeKey = v.required("membershipTypeKey", raw.membershipTypeKey);
    if (membershipTypeKey && !batch.membershipTypeKeys.has(membershipTypeKey)) {
      errors.push(
        `${JOINING_FEES_FILE} row ${i + 2}: membershipTypeKey — unknown membership type "${membershipTypeKey}"`,
      );
    }
    const ageTier = nz(raw.ageTier) === null ? null : v.enum("ageTier", "AgeTier", raw.ageTier);
    const effectiveFrom = v.date("effectiveFrom", raw.effectiveFrom);
    const effectiveTo = nz(raw.effectiveTo) === null ? null : v.date("effectiveTo", raw.effectiveTo);
    const amountCents = v.moneyCents("amountCents", raw.amountCents);
    if (!v.ok || !batch.membershipTypeKeys.has(membershipTypeKey)) return;
    out.joiningFees.push({
      raw,
      membershipTypeKey,
      ageTier,
      effectiveFrom,
      key: `${membershipTypeKey}/${ageTier ?? ""}/${toDateStr(effectiveFrom)}`,
      data: { amountCents, effectiveTo },
    });
  });

  readCsvRows(files, ANNUAL_FEES_FILE).forEach((raw, i) => {
    const v = new RowValidator(ANNUAL_FEES_FILE, i, errors);
    const membershipTypeKey = v.required("membershipTypeKey", raw.membershipTypeKey);
    if (membershipTypeKey && !batch.membershipTypeKeys.has(membershipTypeKey)) {
      errors.push(
        `${ANNUAL_FEES_FILE} row ${i + 2}: membershipTypeKey — unknown membership type "${membershipTypeKey}"`,
      );
    }
    const effectiveFrom = v.date("effectiveFrom", raw.effectiveFrom);
    const effectiveTo = nz(raw.effectiveTo) === null ? null : v.date("effectiveTo", raw.effectiveTo);
    const amountCents = v.moneyCents("amountCents", raw.amountCents);
    const billingBasis = v.enum("billingBasis", "MembershipFeeBillingBasis", raw.billingBasis);
    const prorationRule =
      nz(raw.prorationRule) === null
        ? DEFAULT_PRORATION_RULE
        : v.enum("prorationRule", "MembershipFeeProrationRule", raw.prorationRule);
    if (!v.ok || !batch.membershipTypeKeys.has(membershipTypeKey)) return;
    out.annualFees.push({
      raw,
      membershipTypeKey,
      effectiveFrom,
      key: parentKey(membershipTypeKey, effectiveFrom),
      parentKey: parentKey(membershipTypeKey, effectiveFrom),
      billingBasis,
      data: { amountCents, effectiveTo, billingBasis, prorationRule },
    });
  });

  readCsvRows(files, ANNUAL_FEE_COMPONENTS_FILE).forEach((raw, i) => {
    const v = new RowValidator(ANNUAL_FEE_COMPONENTS_FILE, i, errors);
    const membershipTypeKey = v.required("membershipTypeKey", raw.membershipTypeKey);
    if (membershipTypeKey && !batch.membershipTypeKeys.has(membershipTypeKey)) {
      errors.push(
        `${ANNUAL_FEE_COMPONENTS_FILE} row ${i + 2}: membershipTypeKey — unknown membership type "${membershipTypeKey}"`,
      );
    }
    const effectiveFrom = v.date("effectiveFrom", raw.effectiveFrom);
    const label = v.required("label", raw.label);
    const amountCents = v.moneyCents("amountCents", raw.amountCents);
    const prorate = nz(raw.prorate) === null ? true : v.bool("prorate", raw.prorate);
    const sortOrder = nz(raw.sortOrder) === null ? 0 : v.int("sortOrder", raw.sortOrder);
    if (!v.ok || !batch.membershipTypeKeys.has(membershipTypeKey)) return;
    out.components.push({
      raw,
      membershipTypeKey,
      effectiveFrom,
      label,
      key: `${parentKey(membershipTypeKey, effectiveFrom)}/${label}`,
      parentKey: parentKey(membershipTypeKey, effectiveFrom),
      data: {
        amountCents,
        prorate,
        xeroAccountCode: nz(raw.xeroAccountCode),
        xeroItemCode: nz(raw.xeroItemCode),
        sortOrder,
      },
    });
  });

  validateComponentInvariant(out, errors);
  return out;
}

/**
 * The #1932 component invariant, checked against the BUNDLE's own amounts so a
 * malformed bundle never reaches a write: a NO_INVOICE fee is a zero total with
 * no components; an invoiceable fee carries >=1 component summing EXACTLY to the
 * fee amount. Every annual-fee row must travel with its full component set (as
 * the export always emits them). Components whose parent fee is not in the
 * bundle are a blocking error (they cannot be reconciled against a total).
 */
function validateComponentInvariant(parsed: ParsedFees, errors: string[]): void {
  const componentsByParent = new Map<string, ParsedComponent[]>();
  for (const c of parsed.components) {
    const list = componentsByParent.get(c.parentKey) ?? [];
    list.push(c);
    componentsByParent.set(c.parentKey, list);
  }
  const feeKeys = new Set(parsed.annualFees.map((f) => f.parentKey));

  for (const parentPk of componentsByParent.keys()) {
    if (!feeKeys.has(parentPk)) {
      errors.push(
        `${ANNUAL_FEE_COMPONENTS_FILE}: component(s) reference annual fee "${parentPk}" which is not present in ${ANNUAL_FEES_FILE} — a component set must travel with its fee so the total can be reconciled`,
      );
    }
  }

  for (const fee of parsed.annualFees) {
    const comps = componentsByParent.get(fee.parentKey) ?? [];
    if (fee.billingBasis === NO_INVOICE) {
      if (comps.length > 0) {
        errors.push(
          `${ANNUAL_FEE_COMPONENTS_FILE}: no-invoice annual fee "${fee.parentKey}" must not carry components`,
        );
      }
      if (fee.data.amountCents !== 0) {
        errors.push(
          `${ANNUAL_FEES_FILE}: no-invoice annual fee "${fee.parentKey}" must have amountCents 0`,
        );
      }
      continue;
    }
    if (comps.length === 0) {
      errors.push(
        `${ANNUAL_FEE_COMPONENTS_FILE}: invoiceable annual fee "${fee.parentKey}" must carry at least one component (in ${ANNUAL_FEE_COMPONENTS_FILE})`,
      );
      continue;
    }
    const sum = comps.reduce((total, c) => total + c.data.amountCents, 0);
    if (sum !== fee.data.amountCents) {
      errors.push(
        `${ANNUAL_FEE_COMPONENTS_FILE}: components for annual fee "${fee.parentKey}" sum to ${sum} cents but the fee amount is ${fee.data.amountCents} cents`,
      );
    }
  }
}

// ---- Plan ------------------------------------------------------------------

async function planMembershipFees(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  const batch = await loadFeesBatch(ctx.db);
  const parsed = parseMembershipFees(ctx.files, batch, errors);

  for (const row of parsed.joiningFees) {
    const current = batch.joiningFees.get(row.key) ?? null;
    fingerprintParts.push(
      `joining-fee:${row.key}:${current ? hashRow(["amountCents", "effectiveTo"], current) : "absent"}`,
    );
    const write = updateDataForMode(ctx.mode, row.raw, row.data);
    const changed = changedFields(write, current);
    items.push({
      entity: "joining-fee",
      key: row.key,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }

  for (const row of parsed.annualFees) {
    const current = batch.annualFees.get(row.key) ?? null;
    fingerprintParts.push(
      `annual-fee:${row.key}:${
        current
          ? hashRow(["amountCents", "effectiveTo", "billingBasis", "prorationRule"], current)
          : "absent"
      }`,
    );
    const write = updateDataForMode(ctx.mode, row.raw, row.data);
    const changed = changedFields(write, current);
    items.push({
      entity: "annual-fee",
      key: row.key,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }

  for (const row of parsed.components) {
    const current = batch.components.get(row.key) ?? null;
    fingerprintParts.push(
      `annual-fee-component:${row.key}:${
        current
          ? hashRow(
              ["amountCents", "prorate", "xeroAccountCode", "xeroItemCode", "sortOrder"],
              current,
            )
          : "absent"
      }`,
    );
    const write = updateDataForMode(ctx.mode, row.raw, row.data);
    const changed = changedFields(write, current);
    items.push({
      entity: "annual-fee-component",
      key: row.key,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }

  return { items, warnings: [], errors, fingerprintParts };
}

// ---- Apply -----------------------------------------------------------------

async function applyMembershipFees(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive collection only
  const batch = await loadFeesBatch(ctx.tx);
  const parsed = parseMembershipFees(ctx.files, batch, errors);

  // Joining fees (JoiningFee, keyed by type x ageTier x effectiveFrom).
  for (const row of parsed.joiningFees) {
    const membershipTypeId = batch.membershipTypeIdByKey.get(row.membershipTypeKey);
    if (!membershipTypeId) {
      result.skipped += 1;
      continue;
    }
    const current = batch.joiningFees.get(row.key) ?? null;
    await applyRow({
      mode: ctx.mode,
      raw: row.raw,
      data: row.data,
      current,
      create: (data) =>
        ctx.tx.joiningFee.create({
          data: {
            membershipTypeId,
            ageTier: row.ageTier as never,
            effectiveFrom: row.effectiveFrom,
            ...(data as object),
          } as never,
        }),
      update: (write) => ctx.tx.joiningFee.update({ where: { id: current!.id }, data: write }),
      result,
    });
  }

  // Annual fees (MembershipAnnualFee, keyed by type x effectiveFrom); keep the
  // resolved fee id per parent so components can attach without re-querying.
  const feeIdByParent = new Map<string, string>();
  for (const row of parsed.annualFees) {
    const membershipTypeId = batch.membershipTypeIdByKey.get(row.membershipTypeKey);
    if (!membershipTypeId) {
      result.skipped += 1;
      continue;
    }
    const current = batch.annualFees.get(row.key) ?? null;
    let feeId = current?.id ?? null;
    await applyRow({
      mode: ctx.mode,
      raw: row.raw,
      data: row.data,
      current,
      create: async (data) => {
        const created = await ctx.tx.membershipAnnualFee.create({
          data: {
            membershipTypeId,
            effectiveFrom: row.effectiveFrom,
            ...(data as object),
          } as never,
          select: { id: true },
        });
        feeId = created.id;
      },
      update: (write) =>
        ctx.tx.membershipAnnualFee.update({ where: { id: current!.id }, data: write as never }),
      result,
    });
    if (feeId) feeIdByParent.set(row.parentKey, feeId);
  }

  // Annual-fee components (MembershipAnnualFeeComponent, keyed by parent fee +
  // label). Upsert-only (never delete), like induction's nested items — a
  // component the bundle drops is left in place (see the docs' upsert caveat).
  for (const row of parsed.components) {
    const feeId = feeIdByParent.get(row.parentKey);
    if (!feeId) {
      result.skipped += 1;
      continue;
    }
    const current = batch.components.get(row.key) ?? null;
    await applyRow({
      mode: ctx.mode,
      raw: row.raw,
      data: row.data,
      current,
      create: (data) =>
        ctx.tx.membershipAnnualFeeComponent.create({
          data: { membershipAnnualFeeId: feeId, label: row.label, ...(data as object) } as never,
        }),
      update: (write) =>
        ctx.tx.membershipAnnualFeeComponent.update({ where: { id: current!.id }, data: write }),
      result,
    });
  }

  return result;
}

export const membershipFeesImporter: CategoryImporter = {
  category: "membership-fees",
  plan: planMembershipFees,
  apply: applyMembershipFees,
};
