import "server-only";

import { getTodayDateOnly } from "@/lib/date-only";
import { APP_CURRENCY } from "@/config/operational";
import { normalizeCancellationRule } from "@/lib/cancellation-rules";
import { resolvePolicyRowsForLodge } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

export type PublicMoney = { amountCents: number; label: string };
export type PublicTokenLodge = { name: string; slug: string };

// Generic grouped-fee view model shared by all three fee embeds (#1933, E7).
// A group is one titled block (a lodge season, a membership type, or a fee
// family); each row is one labelled amount with an optional audience qualifier
// (e.g. Member / Non-member). Public names only — never ids or provider codes.
export type PublicFeeRow = { label: string; audience?: string; fee: PublicMoney };
export type PublicFeeGroup = { heading: string; rows: PublicFeeRow[] };

export type PublicBookingPolicy = {
  lodge: PublicTokenLodge | null;
  hold: string | null;
  periods: Array<{ name: string; dateRange: string; hold: string | null }>;
  minimumStays: Array<{ name: string; dateRange: string; minimumNights: number; triggerDays: string }>;
  groupDiscount: string | null;
};

export type PublicCancellationPolicy = {
  lodge: PublicTokenLodge | null;
  tiers: Array<{ description: string }>;
  periods: Array<{ name: string; dateRange: string; tiers: Array<{ description: string }> }>;
};

type PublicCancellationRuleInput = Parameters<typeof normalizeCancellationRule>[0];

function money(amountCents: number): PublicMoney {
  return {
    amountCents,
    label: new Intl.NumberFormat("en-NZ", {
      style: "currency",
      currency: APP_CURRENCY,
    }).format(amountCents / 100),
  };
}

type PublicContentGate = "membershipTypes" | "entranceFees" | "hutFees" | "annualFees" | "bookingPolicySummary" | "cancellationPolicy";

async function isPublicContentEnabled(gate: PublicContentGate): Promise<boolean> {
  const settings = await prisma.publicContentSettings.findUnique({
    where: { id: "default" },
    select: { [gate]: true },
  });
  return settings?.[gate] === true;
}

function dateRange(start: Date, end: Date): string {
  const formatter = new Intl.DateTimeFormat("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Pacific/Auckland",
  });
  return `${formatter.format(start)} to ${formatter.format(end)}`;
}

function sentenceCase(value: string): string {
  const text = value.replaceAll("_", " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function describeCancellationTerms(rawRule: PublicCancellationRuleInput): string {
  const rule = normalizeCancellationRule(rawRule);
  const cardFee = rule.fixedFeeCents > 0 ? ` less a ${money(rule.fixedFeeCents).label} fee` : "";
  const creditFee = rule.creditFixedFeeCents > 0 ? ` less a ${money(rule.creditFixedFeeCents).label} fee` : "";
  const differs = rule.refundPercentage !== rule.creditRefundPercentage || rule.fixedFeeCents !== rule.creditFixedFeeCents;
  return differs
    ? `${rule.refundPercentage}% card refund${cardFee}; ${rule.creditRefundPercentage}% credit refund${creditFee}`
    : `${rule.refundPercentage}% refund${cardFee}`;
}

/**
 * Mirrors getRefundTier's descending threshold semantics without suggesting
 * that a zero-day tier applies after check-in. Every schedule ends with the
 * explicit no-refund result used when daysUntilCheckIn is negative.
 */
export function describePublicCancellationRules(
  rawRules: PublicCancellationRuleInput[],
): Array<{ description: string }> {
  const rules = rawRules
    .map(normalizeCancellationRule)
    .sort((a, b) => b.daysBeforeStay - a.daysBeforeStay);
  if (rules.length === 0) return [];
  // Array#sort is stable: equal thresholds retain persisted order, matching
  // getRefundTier. Keep the first and discard unreachable dirty duplicates.
  const seenThresholds = new Set<number>();
  const reachableRules = rules.filter((rule) => {
    if (seenThresholds.has(rule.daysBeforeStay)) return false;
    seenThresholds.add(rule.daysBeforeStay);
    return true;
  });
  const rows = reachableRules.map((rule, index) => {
    const previous = reachableRules[index - 1];
    const range = index === 0
      ? `${rule.daysBeforeStay} or more days before check-in`
      : `${rule.daysBeforeStay}–${Math.max(rule.daysBeforeStay, previous.daysBeforeStay - 1)} days before check-in`;
    return { description: `${range}: ${describeCancellationTerms(rule)}` };
  });
  const lowest = reachableRules.at(-1)?.daysBeforeStay;
  if (lowest !== undefined && lowest > 0) {
    const range = lowest === 1
        ? "0 days before check-in"
        : `0–${lowest - 1} days before check-in`;
    rows.push({ description: `${range}: no refund` });
  }
  rows.push({ description: "After check-in: no refund" });
  return rows;
}

async function findPublicLodge(slug: string): Promise<PublicTokenLodge & { id: string } | null> {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return null;
  return prisma.lodge.findFirst({
    where: { slug: normalized, active: true },
    select: { id: true, name: true, slug: true },
  });
}

async function publicLodges(slug?: string): Promise<Array<PublicTokenLodge & { id: string }>> {
  if (slug !== undefined) {
    const lodge = await findPublicLodge(slug);
    return lodge ? [lodge] : [];
  }
  return prisma.lodge.findMany({
    where: { active: true },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { id: true, name: true, slug: true },
  });
}

// Active effective-dated window helper (from <= today <= to-or-open).
function activeWindow(today: Date) {
  return {
    effectiveFrom: { lte: today },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
  };
}

async function loadAgeTierLabels(): Promise<Map<string, { label: string; sortOrder: number }>> {
  const ageTiers = await prisma.ageTierSetting.findMany({
    orderBy: [{ sortOrder: "asc" }, { minAge: "asc" }],
    select: { tier: true, label: true, sortOrder: true },
  });
  return new Map(ageTiers.map((tier) => [tier.tier, { label: tier.label.trim() || sentenceCase(tier.tier), sortOrder: tier.sortOrder }]));
}

const ageLabel = (
  tiers: Map<string, { label: string; sortOrder: number }>,
  tier: string | null,
): string => (tier === null ? "All ages" : tiers.get(tier)?.label || sentenceCase(tier));
const ageSort = (
  tiers: Map<string, { label: string; sortOrder: number }>,
  tier: string | null,
): number => (tier === null ? Number.MAX_SAFE_INTEGER : tiers.get(tier)?.sortOrder ?? Number.MAX_SAFE_INTEGER);

export type PublicJoiningFeeOptions = { typeKey?: string; byAge?: boolean };

/**
 * Public joining fees, grouped either by membership type (default) or by age
 * tier (byAge). Reads only publicly-listed active membership types; an unknown
 * or unlisted `typeKey` yields the empty state (never another type's data).
 */
export async function loadPublicJoiningFees(
  options: PublicJoiningFeeOptions = {},
): Promise<PublicFeeGroup[]> {
  if (!(await isPublicContentEnabled("entranceFees"))) return [];
  const today = getTodayDateOnly();
  const [types, tiers] = await Promise.all([
    prisma.membershipType.findMany({
      where: { isActive: true, publiclyListed: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        key: true,
        name: true,
        ageGroupsApply: true,
        joiningFees: {
          where: activeWindow(today),
          orderBy: [{ effectiveFrom: "desc" }],
          select: { ageTier: true, amountCents: true },
        },
      },
    }),
    loadAgeTierLabels(),
  ]);
  const listed = options.typeKey
    ? types.filter((type) => type.key.toLowerCase() === options.typeKey!.toLowerCase())
    : types;
  if (listed.length === 0) return [];

  // Current amount per (type, tier): rows are effectiveFrom desc, so the first
  // seen per tier is current. A flat (non-age) type keys on the null tier.
  type Cell = { typeName: string; tier: string | null; amountCents: number };
  const cells: Cell[] = [];
  for (const type of listed) {
    const seen = new Set<string>();
    for (const row of type.joiningFees) {
      const key = row.ageTier ?? "FLAT";
      if (seen.has(key)) continue;
      seen.add(key);
      cells.push({ typeName: type.name, tier: type.ageGroupsApply ? row.ageTier : null, amountCents: row.amountCents });
    }
  }
  if (cells.length === 0) return [];

  if (options.byAge) {
    // Group by age tier; rows are membership types.
    const byTier = new Map<string, { tier: string | null; rows: PublicFeeRow[] }>();
    for (const cell of cells) {
      const key = cell.tier ?? "FLAT";
      const group = byTier.get(key) ?? { tier: cell.tier, rows: [] };
      group.rows.push({ label: cell.typeName, fee: money(cell.amountCents) });
      byTier.set(key, group);
    }
    return [...byTier.values()]
      .sort((a, b) => ageSort(tiers, a.tier) - ageSort(tiers, b.tier))
      .map((group) => ({ heading: ageLabel(tiers, group.tier), rows: group.rows }));
  }

  // Default: group by membership type; rows are age tiers.
  const byType = new Map<string, PublicFeeRow[]>();
  const order: string[] = [];
  for (const cell of cells) {
    if (!byType.has(cell.typeName)) { byType.set(cell.typeName, []); order.push(cell.typeName); }
    byType.get(cell.typeName)!.push({ label: ageLabel(tiers, cell.tier), fee: money(cell.amountCents) });
  }
  return order.map((typeName) => ({
    heading: typeName,
    rows: byType.get(typeName)!.slice().sort((a, b) =>
      ageSort(tiers, tierForLabel(tiers, a.label)) - ageSort(tiers, tierForLabel(tiers, b.label))),
  }));
}

// Reverse a rendered age label back to its tier key for row ordering. Only used
// to keep the default (by-type) rows in the configured age order.
function tierForLabel(
  tiers: Map<string, { label: string; sortOrder: number }>,
  label: string,
): string | null {
  if (label === "All ages") return null;
  for (const [tier, meta] of tiers) if (meta.label === label) return tier;
  return null;
}

export type PublicAnnualFeeOptions = { typeKey?: string; components?: boolean };

/**
 * Public annual membership fees (#2067 per-tier). By default one "Annual
 * membership fees" group lists the current total per publicly-listed type ×
 * age tier as "Type — TierLabel" rows; a flat (NULL-tier) fee, or any fee on a
 * type whose `ageGroupsApply` is false, collapses to a plain "Type" row
 * (mirroring loadPublicJoiningFees). `components` opts into the E6 per-component
 * breakdown (one group per type × tier). Rows are deduped to the current
 * (latest effectiveFrom) fee per tier; a tier whose current fee is NO_INVOICE,
 * and types with no current fee, are omitted. Gated by the dedicated annualFees
 * double-opt-in (D-R4). Unknown/unlisted `typeKey` → empty state.
 */
export async function loadPublicAnnualFees(
  options: PublicAnnualFeeOptions = {},
): Promise<PublicFeeGroup[]> {
  if (!(await isPublicContentEnabled("annualFees"))) return [];
  const today = getTodayDateOnly();
  const [types, tiers] = await Promise.all([
    prisma.membershipType.findMany({
      where: { isActive: true, publiclyListed: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        key: true,
        name: true,
        ageGroupsApply: true,
        annualFees: {
          where: activeWindow(today),
          orderBy: { effectiveFrom: "desc" },
          select: {
            ageTier: true,
            amountCents: true,
            billingBasis: true,
            components: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { label: true, amountCents: true } },
          },
        },
      },
    }),
    loadAgeTierLabels(),
  ]);
  const listed = options.typeKey
    ? types.filter((type) => type.key.toLowerCase() === options.typeKey!.toLowerCase())
    : types;
  if (listed.length === 0) return [];

  // Current fee per (type, tier): rows are effectiveFrom desc, so the first seen
  // per tier is current. A flat (non-age) type keys on the null tier. A tier
  // whose current fee is NO_INVOICE is omitted (marked seen, then skipped) so an
  // older invoiceable row never resurfaces.
  type Cell = {
    typeName: string;
    tier: string | null;
    amountCents: number;
    components: Array<{ label: string; amountCents: number }>;
  };
  const cells: Cell[] = [];
  for (const type of listed) {
    const typeCells: Cell[] = [];
    const seen = new Set<string>();
    for (const row of type.annualFees) {
      const dedupeKey = row.ageTier ?? "FLAT";
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      if (row.billingBasis === "NO_INVOICE") continue;
      typeCells.push({
        typeName: type.name,
        tier: type.ageGroupsApply ? row.ageTier : null,
        amountCents: row.amountCents,
        components: row.components,
      });
    }
    // Age order within the type; a flat/collapsed (null) row sorts last.
    typeCells.sort((a, b) => ageSort(tiers, a.tier) - ageSort(tiers, b.tier));
    cells.push(...typeCells);
  }
  if (cells.length === 0) return [];

  const rowLabel = (cell: Cell) =>
    cell.tier === null ? cell.typeName : `${cell.typeName} — ${ageLabel(tiers, cell.tier)}`;

  if (options.components) {
    // One group per type × tier; rows are the fee's invoice-line components.
    return cells
      .map((cell) => ({
        heading: rowLabel(cell),
        rows: (cell.components.length > 0
          ? cell.components.map((component) => ({ label: component.label, fee: money(component.amountCents) }))
          : [{ label: "Annual membership fee", fee: money(cell.amountCents) }]),
      }))
      .filter((group) => group.rows.length > 0);
  }

  // Default: a single group of "Type — TierLabel" → total rows.
  return [{
    heading: "Annual membership fees",
    rows: cells.map((cell) => ({ label: rowLabel(cell), fee: money(cell.amountCents) })),
  }];
}

export type PublicHutFeeOptions = { typeKey?: string; groupBy?: Set<"type" | "age"> };

/**
 * Public hut nightly fees. Each active season (per lodge) is a group; rows are
 * the age-tier × audience (Member / Non-member) grid. `group-by=type` splits a
 * season into a Member group and a Non-member group; otherwise both audiences
 * sit in one season group. An unknown `typeKey` yields the empty state; a
 * known one is accepted without further filtering (public hut rates carry the
 * retained member/non-member split, not per-type rows — E4/E13 nuance).
 */
export async function loadPublicHutFees(
  slug?: string,
  options: PublicHutFeeOptions = {},
): Promise<PublicFeeGroup[]> {
  if (!(await isPublicContentEnabled("hutFees"))) return [];
  const lodges = await publicLodges(slug);
  if (lodges.length === 0) return [];
  if (options.typeKey) {
    const known = await prisma.membershipType.findFirst({
      where: { isActive: true, publiclyListed: true, key: { equals: options.typeKey, mode: "insensitive" } },
      select: { id: true },
    });
    if (!known) return [];
  }
  const [seasons, tiers] = await Promise.all([
    prisma.season.findMany({
      where: { active: true, lodgeId: { in: lodges.map((lodge) => lodge.id) } },
      orderBy: [{ startDate: "asc" }, { name: "asc" }],
      select: {
        lodgeId: true,
        name: true,
        startDate: true,
        endDate: true,
        rates: {
          orderBy: [{ isMember: "desc" }, { ageTier: "asc" }],
          select: { ageTier: true, isMember: true, pricePerNightCents: true },
        },
      },
    }),
    loadAgeTierLabels(),
  ]);
  const splitByAudience = options.groupBy?.has("type") ?? false;
  const groups: PublicFeeGroup[] = [];
  for (const { id, name: lodgeName } of lodges) {
    for (const season of seasons.filter((row) => row.lodgeId === id)) {
      const seasonTitle = `${lodgeName} — ${season.name} (${dateRange(season.startDate, season.endDate)}) nightly rates`;
      const cells = [...season.rates]
        .map((rate) => ({
          tier: rate.ageTier,
          audience: rate.isMember ? "Member" : "Non-member",
          fee: money(rate.pricePerNightCents),
        }))
        .sort((a, b) =>
          ageSort(tiers, a.tier) - ageSort(tiers, b.tier) ||
          a.audience.localeCompare(b.audience));
      if (cells.length === 0) continue;
      if (splitByAudience) {
        for (const audience of ["Member", "Non-member"]) {
          const rows = cells
            .filter((cell) => cell.audience === audience)
            .map((cell) => ({ label: ageLabel(tiers, cell.tier), fee: cell.fee }));
          if (rows.length > 0) groups.push({ heading: `${seasonTitle} · ${audience}`, rows });
        }
      } else {
        groups.push({
          heading: seasonTitle,
          rows: cells.map((cell) => ({ label: ageLabel(tiers, cell.tier), audience: cell.audience, fee: cell.fee })),
        });
      }
    }
  }
  return groups;
}

export async function loadPublicBookingPolicy(slug?: string): Promise<PublicBookingPolicy | null> {
  if (!(await isPublicContentEnabled("bookingPolicySummary"))) return null;
  const lodge = slug === undefined ? null : await findPublicLodge(slug);
  if (slug !== undefined && !lodge) return null;
  const today = getTodayDateOnly();
  const [defaults, periods, minimumStays, discount] = await Promise.all([
    prisma.bookingDefaults.findUnique({
      where: { id: "default" },
      select: { nonMemberHoldEnabled: true, nonMemberHoldDays: true },
    }),
    prisma.bookingPeriod.findMany({
      where: {
        active: true,
        ...(lodge ? { OR: [{ lodgeId: lodge.id }, { lodgeId: null }] } : { lodgeId: null }),
      },
      orderBy: [{ startDate: "asc" }, { name: "asc" }],
      select: {
        name: true, startDate: true, endDate: true, nonMemberHoldEnabled: true,
        nonMemberHoldDays: true, lodgeId: true,
      },
    }),
    prisma.minimumStayPolicy.findMany({
      where: {
        active: true,
        ...(lodge ? { OR: [{ lodgeId: lodge.id }, { lodgeId: null }] } : { lodgeId: null }),
      },
      orderBy: [{ startDate: "asc" }, { name: "asc" }],
      select: { name: true, startDate: true, endDate: true, minimumNights: true, triggerDays: true, lodgeId: true },
    }),
    prisma.groupDiscountSetting.findUnique({
      where: { id: "default" },
      select: { enabled: true, minGroupSize: true, summerOnly: true },
    }),
  ]);
  const effectivePeriods = (lodge ? resolvePolicyRowsForLodge(periods, lodge.id) : periods).filter((period) => period.endDate >= today);
  const effectiveMinimumStays = (lodge ? resolvePolicyRowsForLodge(minimumStays, lodge.id) : minimumStays).filter((policy) => policy.endDate >= today);
  const holdText = (enabled: boolean, days: number) => enabled
    ? `Non-member bookings may be held provisionally for up to ${days} ${days === 1 ? "day" : "days"}.`
    : "Non-member bookings are not held provisionally.";
  return {
    lodge: lodge ? { name: lodge.name, slug: lodge.slug } : null,
    hold: defaults ? holdText(defaults.nonMemberHoldEnabled, defaults.nonMemberHoldDays) : null,
    periods: effectivePeriods.map((period) => ({
      name: period.name,
      dateRange: dateRange(period.startDate, period.endDate),
      hold: holdText(period.nonMemberHoldEnabled, period.nonMemberHoldDays),
    })),
    minimumStays: effectiveMinimumStays.map((policy) => ({
      name: policy.name,
      dateRange: dateRange(policy.startDate, policy.endDate),
      minimumNights: policy.minimumNights,
      triggerDays: policy.triggerDays.length === 0
        ? "all check-in days"
        : policy.triggerDays.map((day) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day] ?? "").filter(Boolean).join(", "),
    })),
    // Type-neutral copy (#1933, E7): the E4 re-key means "member rate" is no
    // longer a single binary, so describe the outcome without naming a type.
    groupDiscount: discount?.enabled
      ? `${discount.summerOnly ? "Summer groups" : "Groups"} of ${discount.minGroupSize} or more are charged the discounted group nightly rate.`
      : null,
  };
}

export async function loadPublicCancellationPolicy(slug?: string): Promise<PublicCancellationPolicy | null> {
  if (!(await isPublicContentEnabled("cancellationPolicy"))) return null;
  const lodge = slug === undefined ? null : await findPublicLodge(slug);
  if (slug !== undefined && !lodge) return null;
  const [rows, periods] = await Promise.all([
    prisma.cancellationPolicy.findMany({
      where: lodge ? { OR: [{ lodgeId: lodge.id }, { lodgeId: null }] } : { lodgeId: null },
      orderBy: { daysBeforeStay: "desc" },
      select: {
        daysBeforeStay: true,
        refundPercentage: true,
        creditRefundPercentage: true,
        fixedFeeCents: true,
        creditFixedFeeCents: true,
        lodgeId: true,
      },
    }),
    prisma.bookingPeriod.findMany({
      where: {
        active: true,
        ...(lodge ? { OR: [{ lodgeId: lodge.id }, { lodgeId: null }] } : { lodgeId: null }),
      },
      orderBy: [{ startDate: "asc" }, { name: "asc" }],
      select: { name: true, startDate: true, endDate: true, cancellationRules: true, lodgeId: true },
    }),
  ]);
  const effectiveRows = lodge ? resolvePolicyRowsForLodge(rows, lodge.id) : rows;
  const today = getTodayDateOnly();
  const effectivePeriods = (lodge ? resolvePolicyRowsForLodge(periods, lodge.id) : periods).filter((period) => period.endDate >= today);
  return {
    lodge: lodge ? { name: lodge.name, slug: lodge.slug } : null,
    tiers: describePublicCancellationRules(effectiveRows),
    periods: effectivePeriods.map((period) => ({
      name: period.name,
      dateRange: dateRange(period.startDate, period.endDate),
      tiers: Array.isArray(period.cancellationRules)
        ? describePublicCancellationRules(period.cancellationRules as unknown as PublicCancellationRuleInput[])
        : [],
    })),
  };
}
