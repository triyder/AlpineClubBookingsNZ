import type {
  EntranceFeeCategory,
  FamilyBillingMode,
  MembershipFeeBillingBasis,
  MembershipFeeProrationRule,
  Prisma,
} from "@prisma/client";
import { formatDateOnly, getTodayDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

export const MEMBERSHIP_FEE_BILLING_BASES = [
  "PER_MEMBER",
  "PER_FAMILY",
  "NO_INVOICE",
] as const satisfies readonly MembershipFeeBillingBasis[];

export const FAMILY_BILLING_MODES = [
  "BILL_FAMILY_VIA_BILLING_MEMBER",
  "BILL_MEMBERS_INDIVIDUALLY",
] as const satisfies readonly FamilyBillingMode[];

// Behaviour-preserving default: existing deployments and a missing settings row
// both read as the pre-#159 family-billing model. Kept in lockstep with the
// schema column default on MembershipSubscriptionBillingSettings.
export const DEFAULT_FAMILY_BILLING_MODE = "BILL_FAMILY_VIA_BILLING_MEMBER" as const satisfies FamilyBillingMode;

// Reads the club-level family billing mode from the singleton settings row.
// A missing row means the club has never edited billing settings, which is
// exactly the behaviour-preserving family-billing default.
export async function getFamilyBillingMode(
  store: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<FamilyBillingMode> {
  const row = await store.membershipSubscriptionBillingSettings.findUnique({
    where: { id: "default" },
    select: { familyBillingMode: true },
  });
  return row?.familyBillingMode ?? DEFAULT_FAMILY_BILLING_MODE;
}

export const MEMBERSHIP_FEE_PRORATION_RULES = [
  "NONE",
  "REMAINING_MONTHS_INCLUSIVE",
] as const satisfies readonly MembershipFeeProrationRule[];

export const ENTRANCE_FEE_CATEGORIES = [
  "ADULT",
  "YOUTH",
  "CHILD",
  "FAMILY",
] as const satisfies readonly EntranceFeeCategory[];

export class FeeScheduleValidationError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
  }
}

export function validateFeeScheduleInput(input: {
  amountCents: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  billingBasis?: MembershipFeeBillingBasis;
}) {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0 || input.amountCents > 2_147_483_647) {
    throw new FeeScheduleValidationError("Amount must be a non-negative integer number of cents.");
  }
  if (!isDateOnlyString(input.effectiveFrom)) {
    throw new FeeScheduleValidationError("Effective from must be a valid YYYY-MM-DD date.");
  }
  if (input.effectiveTo && !isDateOnlyString(input.effectiveTo)) {
    throw new FeeScheduleValidationError("Effective to must be a valid YYYY-MM-DD date.");
  }
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    throw new FeeScheduleValidationError("Effective to cannot be before effective from.");
  }
  if (input.billingBasis === "NO_INVOICE" && input.amountCents !== 0) {
    throw new FeeScheduleValidationError("No-invoice fees must have a zero-cent amount.");
  }
  return {
    amountCents: input.amountCents,
    effectiveFrom: parseDateOnly(input.effectiveFrom),
    effectiveTo: input.effectiveTo ? parseDateOnly(input.effectiveTo) : null,
  };
}

export function scheduleOverlapWhere(input: {
  effectiveFrom: Date;
  effectiveTo: Date | null;
  excludeId?: string;
}) {
  return {
    ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
    effectiveFrom: input.effectiveTo ? { lte: input.effectiveTo } : undefined,
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.effectiveFrom } }],
  };
}

export function serializeFeeSchedule<T extends {
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>(row: T) {
  return {
    ...row,
    effectiveFrom: formatDateOnly(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? formatDateOnly(row.effectiveTo) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getEffectiveEntranceFee(
  category: EntranceFeeCategory,
  asOf: Date = getTodayDateOnly(),
): Promise<{ amountCents: number | null; source: "SCHEDULE" | "LEGACY_MAPPING" | "NONE" }> {
  const schedule = await prisma.entranceFee.findFirst({
    where: {
      category,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
    },
    orderBy: { effectiveFrom: "desc" },
    select: { amountCents: true },
  });
  if (schedule) return { amountCents: schedule.amountCents, source: "SCHEDULE" };

  // One-release compatibility fallback. Item/account codes remain Xero
  // configuration; only these deprecated amount fields are consulted here.
  const granular = await prisma.xeroItemCodeMapping.findFirst({
    where: { category: "ENTRANCE_FEE", entranceFeeCategory: category },
    select: { amountCents: true },
  });
  if (granular?.amountCents != null && Number.isSafeInteger(granular.amountCents) && granular.amountCents >= 0) {
    return { amountCents: granular.amountCents, source: "LEGACY_MAPPING" };
  }
  const legacy = await prisma.xeroAccountMapping.findUnique({
    where: { key: "entranceFeeAmountCents" },
    select: { code: true },
  });
  const parsed = legacy?.code && /^\d+$/.test(legacy.code) ? Number(legacy.code) : null;
  return parsed != null && Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 2_147_483_647
    ? { amountCents: parsed, source: "LEGACY_MAPPING" }
    : { amountCents: null, source: "NONE" };
}

export async function getEffectiveMembershipAnnualFee(
  membershipTypeId: string,
  asOf: Date = getTodayDateOnly(),
  store: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return store.membershipAnnualFee.findFirst({
    where: {
      membershipTypeId,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
}

export async function lockFeeSchedule(
  tx: Prisma.TransactionClient,
  domain: "membership" | "entrance",
  key: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fee-schedule:${domain}:${key}`}))`;
}
