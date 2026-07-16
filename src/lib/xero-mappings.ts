/**
 * Xero Reference Mappings
 *
 * Resolves Xero account codes and item codes from configured DB tables, with
 * legacy fallbacks. Also categorises entrance fees and produces stable
 * idempotency keys for entrance-fee invoices.
 */

import { EntranceFeeCategory, type Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";
import { getEffectiveEntranceFee } from "@/lib/authoritative-fees";

export interface EntranceFeeContext {
  category: EntranceFeeCategory;
  feeMapping: {
    itemCode: string | null;
    amountCents: number | null;
  };
  description?: string | null;
  /**
   * Organisations/schools (the NOT_APPLICABLE age tier) are exempt from
   * entrance fees — owner decision, 2026-07-07 (#1440 follow-up). Both
   * invoice paths skip (never bill) when this is set, even when an explicit
   * amount override is supplied.
   */
  exempt?: boolean;
}

export const ENTRANCE_FEE_EXEMPT_MESSAGE =
  "Organisations and schools (N/A age tier) are exempt from entrance fees.";

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

export async function getResolvedAccountMapping(
  key: string,
  store: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ResolvedAccountMapping> {
  try {
    const mapping = await store.xeroAccountMapping.findUnique({
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
async function getItemCodeMapping(key: string): Promise<string | null> {
  const mapping = await getResolvedAccountMapping(key);
  return mapping.itemCode;
}

// Resolver for hut-fee Xero item codes keyed by membership type (#1930, E4).
// `byKey` is `${membershipTypeId}_${seasonType}_${ageTier|"FLAT"}` ->
// itemCode. A guest's code is resolved from its BookingGuest.rateMembershipType
// snapshot; a NULL snapshot (pre-refactor booking) falls back
// isMember -> FULL/NON_MEMBER, which — because the backfill fanned the old
// isMember=true code to FULL and isMember=false code to NON_MEMBER — yields the
// same code the legacy `${ageTier}_${seasonType}_${isMember}` key did.
export interface HutFeeItemCodeResolver {
  byKey: Map<string, string>;
  fullTypeId: string | null;
  nonMemberTypeId: string | null;
  legacyItemCode: string | null;
  // Count of membership-type-keyed rows found, for `.size > 0`-style guards
  // that decide whether to attach any per-guest item code at all.
  size: number;
}

function hutFeeItemCodeKey(
  membershipTypeId: string,
  seasonType: string,
  ageTier: string | null,
): string {
  return `${membershipTypeId}_${seasonType}_${ageTier ?? "FLAT"}`;
}

/**
 * Build the hut-fee item-code resolver keyed by membership type (#1930, E4).
 * Reads the membership-type-keyed HUT_FEE rows (membershipTypeId set); a truly
 * empty table falls back to the legacy flat `hutFeeItem`.
 */
export async function getHutFeeItemCodeMap(): Promise<HutFeeItemCodeResolver> {
  const byKey = new Map<string, string>();

  const [rows, builtInTypes, legacyItemCode] = await Promise.all([
    prisma.xeroItemCodeMapping.findMany({ where: { category: "HUT_FEE" } }),
    prisma.membershipType.findMany({
      where: { key: { in: ["FULL", "NON_MEMBER"] } },
      select: { id: true, key: true },
    }),
    getItemCodeMapping("hutFeeItem"),
  ]);

  for (const row of rows) {
    if (row.membershipTypeId && row.seasonType && row.itemCode) {
      byKey.set(
        hutFeeItemCodeKey(row.membershipTypeId, row.seasonType, row.ageTier),
        row.itemCode,
      );
    }
  }

  const typeIdByKey = new Map(builtInTypes.map((t) => [t.key, t.id]));
  return {
    byKey,
    fullTypeId: typeIdByKey.get("FULL") ?? null,
    nonMemberTypeId: typeIdByKey.get("NON_MEMBER") ?? null,
    legacyItemCode: legacyItemCode ?? null,
    size: byKey.size,
  };
}

/**
 * Whether the hut-fee resolver is configured at all: it carries membership-type
 * keyed rows OR the legacy flat `hutFeeItem` code. Mirrors main's
 * `hutFeeItemCodeMap.size > 0` guard (the legacy map was pre-filled from
 * `hutFeeItem` when the keyed table was empty), so callers fall back to the
 * single `hutFeesIncome` item code exactly when main did (#1930, E4).
 */
export function isHutFeeResolverConfigured(
  resolver: HutFeeItemCodeResolver,
): boolean {
  return resolver.byKey.size > 0 || resolver.legacyItemCode != null;
}

/**
 * Resolve one guest's hut-fee Xero item code (#1930, E4). Prefers the guest's
 * rateMembershipType snapshot; a NULL snapshot falls back isMember ->
 * FULL/NON_MEMBER. Within a type, prefers the exact age-tier row then the flat
 * (FLAT) row.
 *
 * Fallback semantics are byte-identical to main's boolean-keyed map:
 *   - keyed rows exist, lookup misses -> null (the line stays account-coded;
 *     the legacy `hutFeeItem` is NOT consulted once keyed rows exist),
 *   - keyed table EMPTY (genuine legacy-only install) -> the flat `hutFeeItem`
 *     (main pre-filled every key with it),
 *   - no seasonType -> null; the caller falls back to the single
 *     `hutFeesIncome` item code (never `hutFeeItem`), matching main's
 *     `(map && seasonType) ? ... : itemCode` precedence.
 */
export function resolveHutFeeItemCode(
  resolver: HutFeeItemCodeResolver,
  guest: {
    ageTier: string;
    isMember: boolean;
    rateMembershipTypeId?: string | null;
  },
  seasonType: string | null | undefined,
): string | null {
  if (!seasonType) return null;
  if (resolver.byKey.size === 0) return resolver.legacyItemCode;
  const typeId =
    guest.rateMembershipTypeId ??
    (guest.isMember ? resolver.fullTypeId : resolver.nonMemberTypeId);
  if (!typeId) return null;
  return (
    resolver.byKey.get(hutFeeItemCodeKey(typeId, seasonType, guest.ageTier)) ??
    resolver.byKey.get(hutFeeItemCodeKey(typeId, seasonType, null)) ??
    null
  );
}

/**
 * Get the Xero item code and authoritative entrance amount for a category.
 * Amounts resolve schedule-first, with deprecated mapping fallback retained
 * for one compatibility release. Provider item codes remain Xero mappings.
 */
async function getEntranceFeeMapping(
  category: EntranceFeeCategory
): Promise<{ itemCode: string | null; amountCents: number | null }> {
  const row = await prisma.xeroItemCodeMapping.findFirst({
    where: { category: "ENTRANCE_FEE", entranceFeeCategory: category },
  });

  const [legacyItemCode, effectiveFee] = await Promise.all([
    row?.itemCode ? Promise.resolve(row.itemCode) : getItemCodeMapping("entranceFeeItem"),
    getEffectiveEntranceFee(category),
  ]);
  return {
    itemCode: row?.itemCode ?? legacyItemCode,
    amountCents: effectiveFee.amountCents,
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
  memberId: string,
  // Optional transaction client (#1886): the membership-approval flow calls
  // this for a member (and family group) created inside a still-open
  // transaction, so those rows are only visible through that same client.
  store: Prisma.TransactionClient | typeof prisma = prisma
): Promise<EntranceFeeCategory> {
  const member = await store.member.findUnique({
    where: { id: memberId },
    select: { ageTier: true },
  });

  if (!member) return "ADULT";

  if (member.ageTier === "YOUTH") return "YOUTH";
  if (member.ageTier === "CHILD" || member.ageTier === "INFANT") return "CHILD";
  // NOT_APPLICABLE (organisations/schools, #1440) nominally falls through to
  // ADULT so this stays a total function over the enum, but such members are
  // exempt from entrance fees entirely — getEntranceFeeContext flags them
  // and both invoice paths skip before any amount is considered (owner
  // decision, 2026-07-07).

  // ADULT tier — check if they qualify for FAMILY rate
  const familyMemberships = await store.familyGroupMember.findMany({
    where: { memberId },
    select: { familyGroupId: true },
  });

  for (const fm of familyMemberships) {
    const groupMembers = await store.familyGroupMember.findMany({
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
  memberId: string,
  // Optional transaction client (#1886) — see determineEntranceFeeCategory.
  // Only the member/family reads go through it; the fee-mapping lookups below
  // read committed configuration tables the caller's transaction never
  // touches, so they intentionally stay on the global client.
  store: Prisma.TransactionClient | typeof prisma = prisma
): Promise<EntranceFeeContext> {
  const member = await store.member.findUnique({
    where: { id: memberId },
    select: { ageTier: true },
  });

  if (member?.ageTier === "NOT_APPLICABLE") {
    // Exempt: no fee mapping is looked up and callers must not bill, even
    // with an explicit amount override.
    return {
      category: "ADULT",
      feeMapping: { itemCode: null, amountCents: null },
      exempt: true,
    };
  }

  const category = await determineEntranceFeeCategory(memberId, store);
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

// F21 (#1886): the Xero `createInvoices` idempotency key for the entrance-fee
// mint is member-scoped ONLY — it deliberately omits amount and category so
// that two operations racing for the same member (e.g. a re-enqueue carrying a
// different amount override or a reclassified category, which produce distinct
// correlation keys and therefore both slip past the enqueue-time dedupe)
// converge on ONE Xero invoice instead of minting two. This mirrors the
// member-scoped contact idempotency key in `findOrCreateXeroContact` (F7,
// #1355), which is the codebase's established way to serialise concurrent
// provider creates WITHOUT holding a DB lock across a Xero call. An entrance
// fee is a one-time per-member charge, so a member-only key matches the
// domain. Kept distinct from the amount-scoped correlation key above, which
// still governs outbox-operation dedupe semantics.
export function buildEntranceFeeInvoiceMintIdempotencyKey(memberId: string) {
  return buildXeroIdempotencyKey(
    "member",
    memberId,
    "entrance-fee-invoice",
    "mint",
    "v1"
  );
}
