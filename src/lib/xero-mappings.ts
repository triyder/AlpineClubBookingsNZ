/**
 * Xero Reference Mappings
 *
 * Resolves Xero account codes and item codes from configured DB tables, with
 * legacy fallbacks. Also categorises entrance fees and produces stable
 * idempotency keys for entrance-fee invoices.
 */

import { EntranceFeeCategory } from "@prisma/client";
import { prisma } from "./prisma";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

export interface EntranceFeeContext {
  category: EntranceFeeCategory;
  feeMapping: {
    itemCode: string | null;
    amountCents: number | null;
  };
  description?: string | null;
}

/** Default fallbacks if no DB record exists or code is null */
const ACCOUNT_MAPPING_DEFAULTS: Record<string, string | null> = {
  hutFeesIncome: "200",
  hutFeeRefunds: "200",
  stripeBankAccount: "606",
  stripeFees: null,
  subscriptionIncome: "203",
  membershipCancellationCredit: "203",
};

export type ResolvedAccountMapping = {
  code: string | null;
  itemCode: string | null;
  codeExplicitlyConfigured: boolean;
};

export async function getResolvedAccountMapping(key: string): Promise<ResolvedAccountMapping> {
  try {
    const mapping = await prisma.xeroAccountMapping.findUnique({
      where: { key },
      select: { code: true, itemCode: true },
    });
    return {
      code: mapping?.code ?? ACCOUNT_MAPPING_DEFAULTS[key] ?? null,
      itemCode: mapping?.itemCode ?? null,
      codeExplicitlyConfigured: mapping?.code != null,
    };
  } catch {
    return {
      code: ACCOUNT_MAPPING_DEFAULTS[key] ?? null,
      itemCode: null,
      codeExplicitlyConfigured: false,
    };
  }
}

/**
 * Read a Xero account code from the DB, falling back to the hard-coded default.
 * Returns null for unconfigured optional mappings (e.g. stripeFees).
 */
export async function getAccountMapping(key: string): Promise<string | null> {
  const mapping = await getResolvedAccountMapping(key);
  return mapping.code;
}

/**
 * Get the Xero Item Code for a given mapping key.
 * Returns null if not configured.
 */
export async function getItemCodeMapping(key: string): Promise<string | null> {
  const mapping = await getResolvedAccountMapping(key);
  return mapping.itemCode;
}

/**
 * Build a lookup map for hut fee item codes keyed by "${ageTier}_${seasonType}_${isMember}".
 * Falls back to the legacy flat `hutFeeItem` from XeroAccountMapping if the new table is empty.
 */
export async function getHutFeeItemCodeMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  const rows = await prisma.xeroItemCodeMapping.findMany({
    where: { category: "HUT_FEE" },
  });

  for (const row of rows) {
    if (row.ageTier && row.seasonType && row.isMember !== null && row.itemCode) {
      map.set(`${row.ageTier}_${row.seasonType}_${row.isMember}`, row.itemCode);
    }
  }

  if (map.size === 0) {
    // Fallback: use legacy flat hutFeeItem for all combinations
    const legacyItemCode = await getItemCodeMapping("hutFeeItem");
    if (legacyItemCode) {
      for (const tier of ["INFANT", "CHILD", "YOUTH", "ADULT"]) {
        for (const season of ["WINTER", "SUMMER"]) {
          for (const member of [true, false]) {
            map.set(`${tier}_${season}_${member}`, legacyItemCode);
          }
        }
      }
    }
  }

  return map;
}

/**
 * Get the entrance fee item code and amount for a specific category.
 * Falls back to the legacy flat entranceFeeItem/entranceFeeAmountCents if the new table is empty.
 */
export async function getEntranceFeeMapping(
  category: EntranceFeeCategory
): Promise<{ itemCode: string | null; amountCents: number | null }> {
  const row = await prisma.xeroItemCodeMapping.findFirst({
    where: { category: "ENTRANCE_FEE", entranceFeeCategory: category },
  });

  if (row) {
    return { itemCode: row.itemCode, amountCents: row.amountCents };
  }

  // Fallback to legacy flat mappings
  const [legacyItemCode, legacyAmount] = await Promise.all([
    getItemCodeMapping("entranceFeeItem"),
    prisma.xeroAccountMapping.findUnique({
      where: { key: "entranceFeeAmountCents" },
      select: { code: true },
    }),
  ]);

  const amountCents = legacyAmount?.code ? parseInt(legacyAmount.code, 10) : null;
  return {
    itemCode: legacyItemCode,
    amountCents: isNaN(amountCents as number) ? null : amountCents,
  };
}

/**
 * Determine the entrance fee category for a member based on their age tier
 * and family group membership.
 *
 * - FAMILY: adult in a family group that has ≥2 adults AND ≥1 child/youth/infant
 * - ADULT: adult member (standalone or no qualifying family group)
 * - YOUTH: youth-tier member
 * - CHILD: child or infant-tier member
 */
export async function determineEntranceFeeCategory(
  memberId: string
): Promise<EntranceFeeCategory> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { ageTier: true },
  });

  if (!member) return "ADULT";

  if (member.ageTier === "YOUTH") return "YOUTH";
  if (member.ageTier === "CHILD" || member.ageTier === "INFANT") return "CHILD";
  // NOT_APPLICABLE (organisations/schools, #1440) deliberately falls through
  // to the ADULT path below: before the backfill these records carried the
  // ADULT default, so this preserves the pre-existing fee behaviour instead
  // of silently changing billing. Entrance fees are a person-onboarding
  // concept and are not expected to run for organisations.

  // ADULT tier — check if they qualify for FAMILY rate
  const familyMemberships = await prisma.familyGroupMember.findMany({
    where: { memberId },
    select: { familyGroupId: true },
  });

  for (const fm of familyMemberships) {
    const groupMembers = await prisma.familyGroupMember.findMany({
      where: { familyGroupId: fm.familyGroupId },
      include: { member: { select: { ageTier: true } } },
    });

    const adults = groupMembers.filter((gm) =>
      gm.member.ageTier === "ADULT"
    );
    const dependents = groupMembers.filter((gm) =>
      gm.member.ageTier === "CHILD" || gm.member.ageTier === "YOUTH" || gm.member.ageTier === "INFANT"
    );

    if (adults.length >= 2 && dependents.length >= 1) {
      return "FAMILY";
    }
  }

  return "ADULT";
}

export async function getEntranceFeeContext(
  memberId: string
): Promise<EntranceFeeContext> {
  const category = await determineEntranceFeeCategory(memberId);
  const feeMapping = await getEntranceFeeMapping(category);

  return { category, feeMapping };
}

export function buildEntranceFeeInvoiceIdempotencyKey(
  memberId: string,
  category: EntranceFeeCategory,
  amountCents: number
) {
  return buildXeroIdempotencyKey(
    "member",
    memberId,
    "entrance-fee-invoice",
    category,
    amountCents,
    "v1"
  );
}
