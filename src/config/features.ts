import { featureFlagsSchema, type FeatureFlags } from "./schema";

export type FeatureFlagKey = keyof FeatureFlags;

/** Maps each feature flag to the env var that toggles it on. */
const FEATURE_ENV_VARS = {
  kiosk: "FEATURE_KIOSK",
  chores: "FEATURE_CHORES",
  financeDashboard: "FEATURE_FINANCE_DASHBOARD",
  waitlist: "FEATURE_WAITLIST",
  xeroIntegration: "FEATURE_XERO_INTEGRATION",
  bedAllocation: "FEATURE_BED_ALLOCATION",
  internetBankingPayments: "FEATURE_INTERNET_BANKING_PAYMENTS",
  groupBookings: "FEATURE_GROUP_BOOKINGS",
  lockers: "FEATURE_LOCKERS",
  induction: "FEATURE_INDUCTION",
  workParties: "FEATURE_WORK_PARTIES",
  promoCodes: "FEATURE_PROMO_CODES",
  hutLeaders: "FEATURE_HUT_LEADERS",
  communications: "FEATURE_COMMUNICATIONS",
  skifieldConditions: "FEATURE_SKIFIELD_CONDITIONS",
} as const satisfies Record<keyof FeatureFlags, string>;

/**
 * Deploy-time default when a feature's env var is unset.
 *
 * The original capability flags default OFF (false): a deploy must opt in with
 * FEATURE_X=true. The newer general-purpose feature modules default ON (true) so
 * the software is fully featured out of the box and each club switches OFF what
 * it doesn't use via the admin Modules page (an explicit FEATURE_X=false still
 * hard-disables at deploy time).
 */
const ENV_DEFAULTS = {
  kiosk: false,
  chores: false,
  financeDashboard: false,
  waitlist: false,
  xeroIntegration: false,
  bedAllocation: false,
  internetBankingPayments: false,
  groupBookings: true,
  lockers: true,
  induction: true,
  workParties: true,
  promoCodes: true,
  hutLeaders: true,
  communications: true,
  skifieldConditions: true,
} as const satisfies Record<keyof FeatureFlags, boolean>;

/**
 * Parse a feature flag env var against its default. The literal "true"/"false"
 * (case-insensitive, trimmed) force a value; anything else — unset or garbage —
 * falls back to the module's ENV_DEFAULTS entry. Parsing stays strict so an
 * accidental value never silently flips a flag.
 */
function parseFlag(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return defaultValue;
}

export function loadFeatureFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  const flags = Object.fromEntries(
    (Object.keys(FEATURE_ENV_VARS) as FeatureFlagKey[]).map((key) => [
      key,
      parseFlag(env[FEATURE_ENV_VARS[key]], ENV_DEFAULTS[key]),
    ]),
  );
  return featureFlagsSchema.parse(flags);
}

/** Eagerly loaded singleton — Phase 4 will wire call sites to this. */
export const featureFlags: FeatureFlags = loadFeatureFlags();

export function isFeatureEnabled(
  flag: FeatureFlagKey,
  flags: FeatureFlags = featureFlags
): boolean {
  return flags[flag];
}
