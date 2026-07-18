import type { AgeTier } from "@prisma/client";
import { getSeasonStartMonth } from "@/lib/financial-year";

/**
 * Returns the first day of the given season year, i.e. the start of the
 * membership financial year. For the default 31 March year-end this is April 1
 * (e.g. getSeasonStartDate(2026) => 2026-04-01).
 */
export function getSeasonStartDate(seasonYear: number): Date {
  const startMonth = getSeasonStartMonth(); // 1-12
  return new Date(seasonYear, startMonth - 1, 1);
}

// test seam
export function computeAge(dateOfBirth: Date, referenceDate: Date): number {
  let age = referenceDate.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = referenceDate.getMonth() - dateOfBirth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getDate() < dateOfBirth.getDate())) {
    age--;
  }
  return age;
}

export type AgeTierSettingData = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking?: boolean;
  familyGroupRequestCreateMemberAllowed?: boolean;
  sortOrder: number;
};

/**
 * The hard-coded age-tier safety net (epic #1943, child C4 / issue #1983).
 *
 * The DB (`AgeTierSetting`) is the sole runtime source of age tiers; this array
 * is only the fallback when the table is empty or the boot-time self-heal has
 * not yet populated it (age classification must never break). It is NO LONGER
 * derived from `config/club.json` — a configured install always reads DB, and
 * `config/club.json ageTiers[]` is now a seed input only.
 *
 * These values are byte-for-byte what a live boot resolved before the config
 * demotion: the 4-tier TAC default shape shared by `config/club.example.json`,
 * `SAFE_DEFAULT_CONFIG` (`src/config/safe-default-config.ts`), and the state a
 * legacy DB reaches after migration
 * `20260412190000_backfill_infant_age_tier_settings` (INFANT 0-4, CHILD 5-9,
 * YOUTH 10-17, ADULT 18+). Keeping it hard-coded means the fallback can never
 * silently change with an edited/absent config file.
 */
export const AGE_TIER_DEFAULTS: AgeTierSettingData[] = [
  {
    tier: "INFANT",
    minAge: 0,
    maxAge: 4,
    label: "Infant (under 5)",
    subscriptionRequiredForBooking: false,
    familyGroupRequestCreateMemberAllowed: true,
    sortOrder: 0,
  },
  {
    tier: "CHILD",
    minAge: 5,
    maxAge: 9,
    label: "Child (5-9)",
    subscriptionRequiredForBooking: false,
    familyGroupRequestCreateMemberAllowed: true,
    sortOrder: 1,
  },
  {
    tier: "YOUTH",
    minAge: 10,
    maxAge: 17,
    label: "Youth (10-17)",
    subscriptionRequiredForBooking: true,
    familyGroupRequestCreateMemberAllowed: false,
    sortOrder: 2,
  },
  {
    tier: "ADULT",
    minAge: 18,
    maxAge: null,
    label: "Adult (18+)",
    subscriptionRequiredForBooking: true,
    familyGroupRequestCreateMemberAllowed: false,
    sortOrder: 3,
  },
];

const LEGACY_THREE_TIER_SETTINGS = [
  { tier: "CHILD" as AgeTier, minAge: 0, maxAge: 9 as number | null, sortOrder: 1 },
  { tier: "YOUTH" as AgeTier, minAge: 10, maxAge: 17 as number | null, sortOrder: 2 },
  { tier: "ADULT" as AgeTier, minAge: 18, maxAge: null as number | null, sortOrder: 3 },
];

export function cloneAgeTierSettings(settings: AgeTierSettingData[]): AgeTierSettingData[] {
  return settings.map((setting) => ({ ...setting }));
}

function isLegacyThreeTierSettings(settings: AgeTierSettingData[]): boolean {
  if (settings.length !== LEGACY_THREE_TIER_SETTINGS.length) {
    return false;
  }

  const sorted = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
  return LEGACY_THREE_TIER_SETTINGS.every((legacy, index) => {
    const actual = sorted[index];
    return (
      actual?.tier === legacy.tier &&
      actual.minAge === legacy.minAge &&
      actual.maxAge === legacy.maxAge &&
      actual.sortOrder === legacy.sortOrder
    );
  });
}

export function normalizeAgeTierSettings(
  settings: AgeTierSettingData[]
): AgeTierSettingData[] {
  if (settings.length === 0 || isLegacyThreeTierSettings(settings)) {
    return cloneAgeTierSettings(AGE_TIER_DEFAULTS);
  }

  return cloneAgeTierSettings(
    [...settings]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((setting) => ({
        ...setting,
        subscriptionRequiredForBooking:
          setting.subscriptionRequiredForBooking ?? true,
        familyGroupRequestCreateMemberAllowed:
          setting.familyGroupRequestCreateMemberAllowed ?? false,
      }))
  );
}

/**
 * Validate that a proposed set of age-tier rows forms a single complete,
 * non-overlapping partition of `[0, ∞)` with ADULT as the unbounded terminal
 * tier (issue #2009 — the interim age-tier SUBSET relaxation).
 *
 * A set is valid iff:
 *   1. It is non-empty.
 *   2. Every tier appears at most once (no duplicate enum slot).
 *   3. ADULT is present — age classification must always have a terminal tier
 *      that catches every age above the highest boundary.
 *   4. ONLY ADULT is unbounded (`maxAge === null`) and ADULT MUST be unbounded;
 *      every other tier has a finite `maxAge`.
 *   5. Sorted by `minAge`, the youngest tier starts at age 0 and each tier's
 *      `maxAge + 1` equals the next tier's `minAge` (no gaps or overlaps), so
 *      ADULT (the null-maxAge tier) necessarily sorts last.
 *
 * Which enum identities make up the subset is otherwise free: `CHILD 0-17 +
 * ADULT 18+` legally skips INFANT and YOUTH, and `ADULT 0+` (ADULT only) is
 * legal. The canonical all-four TAC install satisfies every clause unchanged.
 *
 * Pure and DB-free so it can be unit-tested directly and reused by the admin
 * save route. On success it returns the rows sorted ascending by age; the caller
 * re-indexes `sortOrder` from that order. NOT_APPLICABLE is rejected by the
 * route's zod schema before this runs, so it is not special-cased here.
 */
export type AgeTierPartitionRow = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
};

export type AgeTierPartitionResult<T extends AgeTierPartitionRow> =
  | { ok: true; sorted: T[] }
  | { ok: false; error: string };

export function validateAgeTierPartition<T extends AgeTierPartitionRow>(
  settings: T[]
): AgeTierPartitionResult<T> {
  if (settings.length === 0) {
    return { ok: false, error: "At least one age tier is required." };
  }

  const tiers = settings.map((s) => s.tier);
  if (new Set(tiers).size !== tiers.length) {
    return { ok: false, error: "Each age tier may appear at most once." };
  }

  // Defense-in-depth: NOT_APPLICABLE is the server-managed organisation/school
  // tier (#1440) — it has no age range and never gets an AgeTierSetting row, so
  // it can never be part of a bookable partition. The admin route's zod already
  // rejects it before this runs; we also reject it here so the pure rule is
  // safe for any caller that skips the zod layer.
  if (tiers.some((tier) => tier === "NOT_APPLICABLE")) {
    return {
      ok: false,
      error: "The N/A age tier is not part of the bookable age partition.",
    };
  }

  const adult = settings.find((s) => s.tier === "ADULT");
  if (!adult) {
    return {
      ok: false,
      error:
        "Age tier settings must include the ADULT tier (the unbounded top tier that classifies every age above the highest boundary).",
    };
  }

  for (const s of settings) {
    if (s.tier !== "ADULT" && s.maxAge === null) {
      return {
        ok: false,
        error:
          "Only the ADULT tier can have no upper age limit (maxAge must be null).",
      };
    }
  }
  if (adult.maxAge !== null) {
    return {
      ok: false,
      error: "ADULT tier must have no upper age limit (maxAge must be null).",
    };
  }

  const sorted = [...settings].sort((a, b) => a.minAge - b.minAge);
  if (sorted[0].minAge !== 0) {
    return {
      ok: false,
      error: `The youngest age tier must start at age 0 (got minAge ${sorted[0].minAge}); otherwise the ages below it would be unclassified.`,
    };
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (current.maxAge === null) {
      return {
        ok: false,
        error: "Only the highest tier (ADULT) can have no upper age limit",
      };
    }
    if (current.maxAge + 1 !== next.minAge) {
      return {
        ok: false,
        error: `Age boundaries must be contiguous: gap or overlap between maxAge ${current.maxAge} and minAge ${next.minAge}`,
      };
    }
  }

  const highest = sorted[sorted.length - 1];
  if (highest.tier !== "ADULT" || highest.maxAge !== null) {
    return {
      ok: false,
      error: "The highest age tier must be ADULT with no upper age limit.",
    };
  }

  return { ok: true, sorted };
}

/**
 * Compute age tier from explicit settings array.
 * Settings are matched in ascending sortOrder; first match wins.
 * Falls back to ADULT if nothing matches.
 */
export function computeAgeTierWithSettings(
  dateOfBirth: Date,
  referenceDate: Date,
  settings: AgeTierSettingData[]
): AgeTier {
  const age = computeAge(dateOfBirth, referenceDate);
  const sorted = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const s of sorted) {
    if (age >= s.minAge && (s.maxAge === null || age <= s.maxAge)) {
      return s.tier;
    }
  }
  return "ADULT";
}
