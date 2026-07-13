import "server-only";

import { getTodayDateOnly } from "@/lib/date-only";
import { APP_CURRENCY } from "@/config/operational";
import { normalizeCancellationRule } from "@/lib/cancellation-rules";
import { resolvePolicyRowsForLodge } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

export type PublicMoney = { amountCents: number; label: string };
export type PublicTokenLodge = { name: string; slug: string };

export type PublicMembershipType = {
  name: string;
  description: string | null;
  annualFee: PublicMoney | null;
  billingLabel: string | null;
};

export type PublicEntranceFee = {
  category: string;
  fee: PublicMoney;
};

export type PublicHutFeeSeason = {
  name: string;
  dateRange: string;
  rates: Array<{ ageTier: string; audience: string; fee: PublicMoney }>;
};

export type PublicHutFeeLodge = PublicTokenLodge & {
  seasons: PublicHutFeeSeason[];
};

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

type PublicContentGate = "membershipTypes" | "entranceFees" | "hutFees" | "bookingPolicySummary" | "cancellationPolicy";

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

export async function loadPublicMembershipTypes(): Promise<PublicMembershipType[]> {
  if (!(await isPublicContentEnabled("membershipTypes"))) return [];
  const today = getTodayDateOnly();
  const rows = await prisma.membershipType.findMany({
    where: { isActive: true, publiclyListed: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      name: true,
      publicDescription: true,
      annualFees: {
        where: {
          effectiveFrom: { lte: today },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
        },
        orderBy: { effectiveFrom: "desc" },
        take: 1,
        select: { amountCents: true, billingBasis: true, prorationRule: true },
      },
    },
  });
  return rows.map((row) => {
    const fee = row.annualFees[0];
    return {
      name: row.name,
      description: row.publicDescription?.trim() || null,
      annualFee: fee && fee.billingBasis !== "NO_INVOICE" ? money(fee.amountCents) : null,
      billingLabel: fee
        ? fee.billingBasis === "NO_INVOICE"
          ? "No invoice required"
          : `${sentenceCase(fee.billingBasis)}; ${fee.prorationRule === "NONE" ? "no proration" : "prorated for remaining months, including the joining month"}`
        : null,
    };
  });
}

export async function loadPublicEntranceFees(): Promise<PublicEntranceFee[]> {
  if (!(await isPublicContentEnabled("entranceFees"))) return [];
  const today = getTodayDateOnly();
  const rows = await prisma.entranceFee.findMany({
    where: {
      effectiveFrom: { lte: today },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
    },
    orderBy: [{ category: "asc" }, { effectiveFrom: "desc" }],
    select: { category: true, amountCents: true },
  });
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (seen.has(row.category)) return [];
    seen.add(row.category);
    return [{ category: sentenceCase(row.category), fee: money(row.amountCents) }];
  });
}

export async function loadPublicHutFees(slug?: string): Promise<PublicHutFeeLodge[]> {
  if (!(await isPublicContentEnabled("hutFees"))) return [];
  const lodges = await publicLodges(slug);
  if (lodges.length === 0) return [];
  const [seasons, ageTiers] = await Promise.all([prisma.season.findMany({
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
  }), prisma.ageTierSetting.findMany({
    orderBy: [{ sortOrder: "asc" }, { minAge: "asc" }],
    select: { tier: true, label: true, sortOrder: true },
  })]);
  const tierByKey = new Map(ageTiers.map((tier) => [tier.tier, tier]));
  return lodges.map(({ id, name, slug: lodgeSlug }) => ({
    name,
    slug: lodgeSlug,
    seasons: seasons.filter((season) => season.lodgeId === id).map((season) => ({
      name: season.name,
      dateRange: dateRange(season.startDate, season.endDate),
      rates: [...season.rates].sort((a, b) =>
        (tierByKey.get(a.ageTier)?.sortOrder ?? Number.MAX_SAFE_INTEGER) -
          (tierByKey.get(b.ageTier)?.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
        a.ageTier.localeCompare(b.ageTier),
      ).map((rate) => ({
        ageTier: tierByKey.get(rate.ageTier)?.label.trim() || sentenceCase(rate.ageTier),
        audience: rate.isMember ? "Member" : "Non-member",
        fee: money(rate.pricePerNightCents),
      })),
    })),
  }));
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
    groupDiscount: discount?.enabled
      ? `${discount.summerOnly ? "Summer groups" : "Groups"} of ${discount.minGroupSize} or more receive member nightly rates.`
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
