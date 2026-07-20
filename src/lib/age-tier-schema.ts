import { AgeTier } from "@prisma/client";
import { z } from "zod";

/**
 * Shared Zod validator for the AgeTier enum.
 * Derived from Prisma's generated AgeTier enum so that adding a new tier
 * to schema.prisma automatically makes all validators accept it.
 */
export const AGE_TIER_VALUES = Object.values(AgeTier) as [
  AgeTier,
  ...AgeTier[],
];

export const ageTierEnum = z.nativeEnum(AgeTier);

/**
 * Person tiers only: NOT_APPLICABLE is the organisation/school member
 * classification (#1440) and is never valid for booking guests or
 * per-tier season rates — those are always people with an age.
 */
const BOOKABLE_AGE_TIER_VALUES = [
  "INFANT",
  "CHILD",
  "YOUTH",
  "ADULT",
] as const satisfies readonly AgeTier[];

export const bookableAgeTierEnum = z.enum(BOOKABLE_AGE_TIER_VALUES);

/**
 * Canonical age-tier ordering used to store a rule's `ageTiers` set in a single
 * deterministic shape (#2093). Any subset is sorted by this order before
 * storage/serialization so `[ADULT, YOUTH]` and `[YOUTH, ADULT]` become the same
 * stored array. The DB shape-unique index compares arrays with ORDER-SENSITIVE
 * btree array equality, so it only dedupes reordered sets because this canonical
 * order is applied before every write (the route's `normalizeRule` calls
 * {@link canonicalizeAgeTiers}); a direct-SQL write of a non-canonical array
 * would bypass it (the app-side dedupe + defensive migration dedupe are the
 * guards for that).
 */
export const CANONICAL_AGE_TIER_ORDER = [
  "INFANT",
  "CHILD",
  "YOUTH",
  "ADULT",
  "NOT_APPLICABLE",
] as const satisfies readonly AgeTier[];

const CANONICAL_AGE_TIER_RANK = new Map<AgeTier, number>(
  CANONICAL_AGE_TIER_ORDER.map((tier, index) => [tier, index]),
);

/**
 * Normalize a rule's selected age tiers into the single canonical shape stored
 * for `XeroContactGroupRule.ageTiers` (#2093, D-B2):
 *  - de-duplicate,
 *  - collapse a full-tier-set selection (every AgeTier ticked) to `[]` so
 *    "all age tiers" has exactly ONE canonical shape (matching the empty-set
 *    "applies to every tier" semantics), and
 *  - sort by {@link CANONICAL_AGE_TIER_ORDER}.
 * The empty array is the "all age tiers" wildcard (the migrated null "Any age").
 */
export function canonicalizeAgeTiers(
  tiers: readonly AgeTier[] | null | undefined,
): AgeTier[] {
  if (!tiers || tiers.length === 0) {
    return [];
  }
  const unique = Array.from(new Set(tiers));
  // Full set selected => "all tiers" => canonical empty set.
  if (unique.length >= CANONICAL_AGE_TIER_ORDER.length) {
    return [];
  }
  return unique.sort(
    (left, right) =>
      (CANONICAL_AGE_TIER_RANK.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (CANONICAL_AGE_TIER_RANK.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}
