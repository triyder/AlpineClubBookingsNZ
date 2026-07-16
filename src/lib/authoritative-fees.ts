import type {
  AgeTier,
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

export type FeeComponentInput = {
  label: string;
  amountCents: number;
  prorate: boolean;
  xeroAccountCode?: string | null;
  xeroItemCode?: string | null;
  sortOrder: number;
};

// The component lifecycle invariant (#1932, E6): a NO_INVOICE fee is a zero total
// with NO components; every invoiceable fee has >=1 component whose amounts sum
// EXACTLY to the fee total, so the fee total stays authoritative and the invoice
// builder never meets a fee with zero components. Enforced server-side in the one
// transaction that writes the fee + its components.
export function validateFeeComponents(input: {
  components: FeeComponentInput[];
  amountCents: number;
  billingBasis: MembershipFeeBillingBasis;
}) {
  const { components, amountCents, billingBasis } = input;
  if (billingBasis === "NO_INVOICE") {
    if (components.length > 0) {
      throw new FeeScheduleValidationError("A no-invoice fee cannot have components.");
    }
    return;
  }
  if (components.length === 0) {
    throw new FeeScheduleValidationError("An invoiceable membership fee must have at least one component.");
  }
  for (const component of components) {
    if (!component.label.trim()) {
      throw new FeeScheduleValidationError("Each fee component must have a label.");
    }
    if (!Number.isSafeInteger(component.amountCents) || component.amountCents < 0 || component.amountCents > 2_147_483_647) {
      throw new FeeScheduleValidationError("Each fee component amount must be a non-negative integer number of cents.");
    }
  }
  const sum = components.reduce((total, component) => total + component.amountCents, 0);
  if (sum !== amountCents) {
    throw new FeeScheduleValidationError(
      `Fee components must sum to the fee amount (${amountCents} cents); the supplied components sum to ${sum} cents.`,
    );
  }
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

export type JoiningFeeScheduleSource = "SCHEDULE" | "NONE";

export interface EffectiveJoiningFee {
  amountCents: number | null;
  effectiveFrom: string | null;
  source: JoiningFeeScheduleSource;
}

/**
 * Resolve the effective joining-fee amount for a membership type x age tier
 * (#1931, E5). Prefers the exact age-tier row, then the type's flat NULL-tier
 * row (the built-in Family type is flat-only, so a Family member of any age
 * resolves the flat family fee). The legacy category-keyed EntranceFee table
 * and the deprecated mapping-amount fallback are gone — the migration
 * materialised every legacy amount into JoiningFee, so this reads JoiningFee
 * only. Accepts an optional transaction client (#1886 contract) so approval can
 * resolve fees for rows created inside the still-open transaction.
 */
export async function getEffectiveJoiningFee(
  params: { membershipTypeId: string; ageTier: AgeTier | null },
  asOf: Date = getTodayDateOnly(),
  store: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<EffectiveJoiningFee> {
  const activeWindow = {
    effectiveFrom: { lte: asOf },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
  };

  if (params.ageTier) {
    const tierRow = await store.joiningFee.findFirst({
      where: { membershipTypeId: params.membershipTypeId, ageTier: params.ageTier, ...activeWindow },
      orderBy: { effectiveFrom: "desc" },
      select: { amountCents: true, effectiveFrom: true },
    });
    if (tierRow) {
      return {
        amountCents: tierRow.amountCents,
        effectiveFrom: formatDateOnly(tierRow.effectiveFrom),
        source: "SCHEDULE",
      };
    }
  }

  const flatRow = await store.joiningFee.findFirst({
    where: { membershipTypeId: params.membershipTypeId, ageTier: null, ...activeWindow },
    orderBy: { effectiveFrom: "desc" },
    select: { amountCents: true, effectiveFrom: true },
  });
  if (flatRow) {
    return {
      amountCents: flatRow.amountCents,
      effectiveFrom: formatDateOnly(flatRow.effectiveFrom),
      source: "SCHEDULE",
    };
  }

  return { amountCents: null, effectiveFrom: null, source: "NONE" };
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
    // Components are the invoice lines (#1932, E6). Order is stable so the
    // preview digest, the frozen charge-component snapshot, and the Xero line
    // array all agree byte-for-byte on line order.
    include: { components: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } },
  });
}

export async function lockFeeSchedule(
  tx: Prisma.TransactionClient,
  domain: "membership" | "entrance" | "joining",
  key: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fee-schedule:${domain}:${key}`}))`;
}
