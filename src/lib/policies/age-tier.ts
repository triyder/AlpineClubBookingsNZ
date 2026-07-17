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
