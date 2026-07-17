import fs from "node:fs";
import path from "node:path";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { AGE_TIER_DEFAULTS } from "@/lib/policies/age-tier";
import { clubConfigSchema, type ClubConfig } from "../config/schema";
import {
  DEFAULT_ADMIN_MODULE_SETTINGS,
  normalizeAdminModuleSettings,
  type AdminModuleKey,
  type AdminModuleSettingsSnapshot,
} from "./admin-modules";
import { resolveEmailDeliveryConfigFromEnv } from "@/lib/email-delivery";
import { XERO_REQUIRED_REPORT_OAUTH_SCOPES } from "@/lib/xero-config";

export const SETUP_STEP_IDS = [
  "club-config",
  "runtime-env",
  "seed-admin",
  "feature-flags",
  "booking-policies",
  "membership-cancellation",
  "age-tiers",
  "seasons-rates",
  "stripe",
  "email-ses",
  "sentry",
  "address-autocomplete",
  "xero-operational",
  "finance-dashboard",
  "xero-mappings",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
type SetupStatus = "complete" | "warning" | "blocked" | "not_started";
type SetupCategoryId =
  | "foundation"
  | "booking"
  | "integrations"
  | "finance";

export interface SetupProgressState {
  completedStepIds: SetupStepId[];
  skippedStepIds: SetupStepId[];
  completedAt: string | null;
  completedByMemberId: string | null;
}

interface SetupProgressInput {
  completedStepIds?: readonly string[];
  skippedStepIds?: readonly string[];
  completedAt?: string | null;
  completedByMemberId?: string | null;
}

export interface SetupDatabaseSnapshot {
  adminCount: number;
  adminModuleSettings?: AdminModuleSettingsSnapshot | null;
  ageTierSettingCount: number;
  seasonCount: number;
  cancellationPolicyCount: number;
  bookingDefaultsConfigured: boolean;
  groupDiscountConfigured: boolean;
  membershipCancellationSettingsConfigured: boolean;
  membershipCancellationXeroGroupCount: number;
  membershipCancellationArchiveContacts: boolean;
  operationalXeroConnected: boolean;
  operationalXeroTokenExpiresAt: string | null;
  xeroAccountMappingCount: number;
  xeroHutFeeItemMappingCount: number;
  xeroEntranceFeeMappingCount: number;
  // Per-membership-type rate gaps (#1930, E4): "TypeName — SeasonName" entries
  // for every MEMBER_RATE type × active/future season whose rate coverage is
  // incomplete (see computeMembershipTypeRateGaps). Any entry means a booking
  // for that type on some (or all) of those dates hard-throws at pricing, so
  // the Seasons And Rates step drops to a warning.
  membershipTypeRateGaps?: string[];
}

// One membership type × season pair for the rate-gap check (#1930, E4).
export interface MembershipTypeRateGapType {
  id: string;
  name: string;
  ageGroupsApply: boolean;
}

export interface MembershipTypeRateGapSeason {
  id: string;
  name: string;
}

export interface MembershipTypeRateGapRow {
  seasonId: string;
  membershipTypeId: string;
  ageTier: string | null;
}

/**
 * Tier-aware missing-rate readiness (#1930, E4). A (type, season) pair is
 * covered when a booking for ANY bookable age tier can price:
 *   - ageGroupsApply=true: every bookable tier has an exact row, OR a flat
 *     (NULL-ageTier) row exists (the engine falls back exact-tier -> flat);
 *   - ageGroupsApply=false: the single flat row exists (tier rows alone are a
 *     shape anomaly the write surfaces reject — flag them).
 * Anything less means some guest hard-throws at pricing. Callers pass ACTIVE
 * MEMBER_RATE types only — archived types price history and are skipped.
 */
export function computeMembershipTypeRateGaps(input: {
  types: MembershipTypeRateGapType[];
  seasons: MembershipTypeRateGapSeason[];
  rateRows: MembershipTypeRateGapRow[];
  bookableAgeTiers?: readonly string[];
}): string[] {
  const bookableTiers = input.bookableAgeTiers ?? bookableAgeTierEnum.options;
  const tiersByPair = new Map<string, Set<string | null>>();
  for (const row of input.rateRows) {
    const key = `${row.membershipTypeId}::${row.seasonId}`;
    const set = tiersByPair.get(key) ?? new Set<string | null>();
    set.add(row.ageTier);
    tiersByPair.set(key, set);
  }

  const gaps: string[] = [];
  for (const type of input.types) {
    for (const season of input.seasons) {
      const tiers = tiersByPair.get(`${type.id}::${season.id}`);
      const hasFlat = tiers?.has(null) ?? false;
      if (type.ageGroupsApply) {
        if (hasFlat) continue;
        const missingTiers = bookableTiers.filter((tier) => !tiers?.has(tier));
        if (missingTiers.length === 0) continue;
        gaps.push(
          `${type.name} — ${season.name} (missing ${missingTiers.join(", ")})`,
        );
      } else {
        if (hasFlat) continue;
        gaps.push(`${type.name} — ${season.name} (missing flat all-ages rate)`);
      }
    }
  }
  return gaps;
}

interface SetupStepCheck {
  id: SetupStepId;
  title: string;
  description: string;
  status: SetupStatus;
  required: boolean;
  message: string;
  details: string[];
  href?: string;
  action?: {
    type: "provider-test";
    provider: "stripe" | "smtp" | "sentry" | "xero";
    label: string;
  };
  progress: "open" | "completed" | "skipped";
}

interface SetupCategory {
  id: SetupCategoryId;
  title: string;
  description: string;
  status: SetupStatus;
  checks: SetupStepCheck[];
}

export interface SetupReadiness {
  status: SetupStatus;
  summary: {
    total: number;
    complete: number;
    warning: number;
    blocked: number;
    skipped: number;
  };
  categories: SetupCategory[];
  generatedAt: string;
}

type Env = Record<string, string | undefined>;

interface ClubConfigReadResult {
  sourcePath: string;
  exists: boolean;
  config: ClubConfig | null;
  issues: string[];
}

const CATEGORY_ORDER: SetupCategoryId[] = [
  "foundation",
  "booking",
  "integrations",
  "finance",
];

const CATEGORY_META: Record<
  SetupCategoryId,
  { title: string; description: string }
> = {
  foundation: {
    title: "Foundation",
    description:
      "Club identity, runtime env, administrator account, and feature switches.",
  },
  booking: {
    title: "Booking Rules",
    description:
      "Capacity, age tiers, rates, seasons, cancellation, and hold settings.",
  },
  integrations: {
    title: "Operational Integrations",
    description: "Stripe, email, Sentry, and operational Xero setup state.",
  },
  finance: {
    title: "Finance",
    description: "Finance dashboard module and Xero chart/item mappings.",
  },
};

const MODULE_CONTROLS = [
  { key: "kiosk", label: "Lodge kiosk" },
  { key: "chores", label: "Chores and roster" },
  { key: "financeDashboard", label: "Finance dashboard" },
  { key: "waitlist", label: "Waitlist" },
  { key: "xeroIntegration", label: "Operational Xero" },
  { key: "bedAllocation", label: "Bed allocation" },
  { key: "internetBankingPayments", label: "Internet Banking payments" },
  { key: "addressAutocomplete", label: "Address autocomplete" },
  { key: "analytics", label: "Google Analytics" },
] as const satisfies readonly {
  key: AdminModuleKey;
  label: string;
}[];

const REQUIRED_RUNTIME_ENV = [
  "DATABASE_URL",
  "NEXTAUTH_URL",
  "CRON_SECRET",
  "SEED_ADMIN_EMAIL",
  "SEED_ADMIN_PASSWORD",
] as const;

function readEnv(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function hasEnv(env: Env, name: string): boolean {
  return Boolean(readEnv(env, name));
}

function isHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isLikelyStripeSecret(value: string | undefined): boolean {
  return Boolean(
    value &&
    (value.startsWith("sk_test_") ||
      value.startsWith("sk_live_") ||
      value.startsWith("rk_")),
  );
}

function isLikelyStripePublishable(value: string | undefined): boolean {
  return Boolean(
    value && (value.startsWith("pk_test_") || value.startsWith("pk_live_")),
  );
}

function isHexEncryptionKey(value: string | undefined): boolean {
  return Boolean(value && /^[0-9a-fA-F]{64}$/.test(value));
}

function toStatusScore(status: SetupStatus): number {
  switch (status) {
    case "blocked":
      return 4;
    case "warning":
      return 3;
    case "not_started":
      return 2;
    case "complete":
      return 1;
  }
}

function worstStatus(statuses: SetupStatus[]): SetupStatus {
  return statuses.reduce<SetupStatus>(
    (worst, status) =>
      toStatusScore(status) > toStatusScore(worst) ? status : worst,
    "complete",
  );
}

function normalizeStepIds(ids: readonly string[] | undefined): SetupStepId[] {
  const valid = new Set<string>(SETUP_STEP_IDS);
  return Array.from(new Set(ids ?? [])).filter((id): id is SetupStepId =>
    valid.has(id),
  );
}

export function normalizeSetupProgress(
  progress?: SetupProgressInput | null,
): SetupProgressState {
  return {
    completedStepIds: normalizeStepIds(progress?.completedStepIds),
    skippedStepIds: normalizeStepIds(progress?.skippedStepIds),
    completedAt: progress?.completedAt ?? null,
    completedByMemberId: progress?.completedByMemberId ?? null,
  };
}

/**
 * Setup-readiness view of the club config, kept in lockstep with the runtime
 * loader `loadClubConfig` (`src/config/club.ts`) under owner decision D3
 * (epic #1943, child C1):
 * - When `club.json` exists it is the source (even if malformed) — a malformed
 *   PRIMARY is reported *blocked* and NEVER falls through to `club.example.json`,
 *   so the app never boots on the example's identity while readiness is blocked.
 * - Only an ABSENT primary falls back to `club.example.json`.
 * The runtime loader mirrors this (malformed primary → SAFE_DEFAULT_CONFIG;
 * absent primary → valid example, else SAFE_DEFAULT_CONFIG) so the two agree.
 */
function readClubConfig(configDir: string): ClubConfigReadResult {
  const primaryPath = path.join(configDir, "club.json");
  const examplePath = path.join(configDir, "club.example.json");
  const sourcePath = fs.existsSync(primaryPath) ? primaryPath : examplePath;

  if (!fs.existsSync(sourcePath)) {
    return {
      sourcePath,
      exists: false,
      config: null,
      issues: [`No club config found at ${primaryPath} or ${examplePath}`],
    };
  }

  try {
    const parsedJson = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    const result = clubConfigSchema.safeParse(parsedJson);
    if (!result.success) {
      return {
        sourcePath,
        exists: true,
        config: null,
        issues: result.error.issues.map((issue) => {
          const fieldPath =
            issue.path.length > 0 ? issue.path.join(".") : "root";
          return `${fieldPath}: ${issue.message}`;
        }),
      };
    }

    return {
      sourcePath,
      exists: true,
      config: result.data,
      issues: [],
    };
  } catch (error) {
    return {
      sourcePath,
      exists: true,
      config: null,
      issues: [
        error instanceof Error
          ? `Invalid JSON in ${sourcePath}: ${error.message}`
          : `Invalid JSON in ${sourcePath}`,
      ],
    };
  }
}

function buildProgressState(
  id: SetupStepId,
  progress: SetupProgressState,
): "open" | "completed" | "skipped" {
  if (progress.completedStepIds.includes(id)) return "completed";
  if (progress.skippedStepIds.includes(id)) return "skipped";
  return "open";
}

function applyProgress(
  check: Omit<SetupStepCheck, "progress">,
  progress: SetupProgressState,
): SetupStepCheck {
  return {
    ...check,
    progress: buildProgressState(check.id, progress),
  };
}

function isResolvedByProgress(check: SetupStepCheck): boolean {
  return check.progress === "completed" || check.progress === "skipped";
}

function unresolvedStatuses(checks: SetupStepCheck[]): SetupStatus[] {
  return checks
    .filter((check) => !isResolvedByProgress(check))
    .map((check) => check.status);
}

function buildClubConfigCheck(
  club: ClubConfigReadResult,
  progress: SetupProgressState,
): SetupStepCheck {
  const capacity =
    club.config?.beds.reduce((total, bed) => total + bed.capacity, 0) ?? 0;
  const details = club.config
    ? [
        `Source: ${club.sourcePath}`,
        `Club: ${club.config.name}`,
        `Configured capacity: ${capacity} beds`,
      ]
    : [`Source: ${club.sourcePath}`, ...club.issues];

  return applyProgress(
    {
      id: "club-config",
      title: "Club Config",
      description:
        "Club identity, contact details, bed capacity, age tiers, and default rates.",
      status: club.config ? "complete" : "blocked",
      required: true,
      message: club.config
        ? `${club.config.name} is configured with ${capacity} total beds.`
        : "A valid config/club.json or config/club.example.json is required.",
      details,
      href: "/admin/setup",
    },
    progress,
  );
}

function buildRuntimeEnvCheck(
  env: Env,
  progress: SetupProgressState,
): SetupStepCheck {
  const missing: string[] = REQUIRED_RUNTIME_ENV.filter(
    (name) => !hasEnv(env, name),
  );
  if (!hasEnv(env, "AUTH_SECRET") && !hasEnv(env, "NEXTAUTH_SECRET")) {
    missing.push("AUTH_SECRET or NEXTAUTH_SECRET");
  }
  const issues = [...missing];
  if (hasEnv(env, "NEXTAUTH_URL") && !isHttpUrl(readEnv(env, "NEXTAUTH_URL"))) {
    issues.push("NEXTAUTH_URL must be a valid http(s) URL");
  }
  const authTrustHost = readEnv(env, "AUTH_TRUST_HOST");
  if (authTrustHost && authTrustHost !== "true" && authTrustHost !== "false") {
    issues.push("AUTH_TRUST_HOST must be true or false");
  }

  return applyProgress(
    {
      id: "runtime-env",
      title: "Runtime Environment",
      description:
        "Database, auth, app origin, cron, and seed-admin environment contract.",
      status: issues.length === 0 ? "complete" : "blocked",
      required: true,
      message:
        issues.length === 0
          ? "Required runtime variables are present and well formed."
          : "Required runtime variables are missing or invalid.",
      details:
        issues.length === 0
          ? REQUIRED_RUNTIME_ENV.map((name) => `${name}: set`).concat([
              hasEnv(env, "AUTH_SECRET")
                ? "AUTH_SECRET: set"
                : "NEXTAUTH_SECRET: set",
            ])
          : issues.map((issue) => `Fix ${issue}`),
    },
    progress,
  );
}

function buildSeedAdminCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  if (!db) {
    return applyProgress(
      {
        id: "seed-admin",
        title: "First Admin",
        description:
          "Seeded administrator account used to access setup and admin tools.",
        status: "warning",
        required: true,
        message: "Database state was not checked.",
        details: [
          "Run setup:check again inside an environment with database access, or review /admin/setup after login.",
        ],
        href: "/admin/members",
      },
      progress,
    );
  }

  const adminCount = db?.adminCount ?? 0;
  return applyProgress(
    {
      id: "seed-admin",
      title: "First Admin",
      description:
        "Seeded administrator account used to access setup and admin tools.",
      status: adminCount > 0 ? "complete" : "blocked",
      required: true,
      message:
        adminCount > 0
          ? `${adminCount} administrator account${adminCount === 1 ? "" : "s"} found.`
          : "Run the seed command after setting SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD.",
      details:
        adminCount > 0
          ? ["Admin login is available."]
          : ["Command: npm run db:seed"],
      href: "/admin/members",
    },
    progress,
  );
}

function buildModuleLayerState(
  db: SetupDatabaseSnapshot | undefined,
  moduleKey: AdminModuleKey,
) {
  const adminActivation =
    db?.adminModuleSettings === undefined
      ? DEFAULT_ADMIN_MODULE_SETTINGS
      : normalizeAdminModuleSettings(db.adminModuleSettings);

  return {
    adminChecked: Boolean(db && db.adminModuleSettings),
    adminEnabled: adminActivation[moduleKey],
    effectiveEnabled: adminActivation[moduleKey],
  };
}

function formatModuleActivationDetail(
  db: SetupDatabaseSnapshot | undefined,
  enabled: boolean,
) {
  if (!db) return "Admin Modules activation: not checked";
  if (!db.adminModuleSettings) {
    return "Admin Modules activation: first-install defaults until settings are saved";
  }
  return `Admin Modules activation: ${enabled ? "enabled" : "disabled"}`;
}

function buildFeatureFlagCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const adminDetails = MODULE_CONTROLS.map((module) => {
    const layer = buildModuleLayerState(db, module.key);
    return `${module.label} ${formatModuleActivationDetail(db, layer.adminEnabled)}`;
  });
  const adminChecked = Boolean(db && db.adminModuleSettings);

  return applyProgress(
    {
      id: "feature-flags",
      title: "Module Controls",
      description:
        "Admin Modules club activation for optional modules.",
      status: adminChecked ? "complete" : "warning",
      required: false,
      message: adminChecked
        ? "Admin Modules activation was checked."
        : "Review optional module activation on the admin Modules page.",
      details: adminDetails,
    },
    progress,
  );
}

function buildBookingPolicyCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  if (!db) {
    return applyProgress(
      {
        id: "booking-policies",
        title: "Booking Policies",
        description:
          "Non-member hold, cancellation rules, minimum stays, and group discount.",
        status: "warning",
        required: true,
        message: "Database booking policies were not checked.",
        details: [
          "Review this in /admin/setup after migrations and seed data have run.",
        ],
        href: "/admin/booking-policies",
      },
      progress,
    );
  }

  const hasCancellation = (db?.cancellationPolicyCount ?? 0) > 0;
  const hasDefaults = Boolean(db?.bookingDefaultsConfigured);
  const complete = hasCancellation && hasDefaults;
  return applyProgress(
    {
      id: "booking-policies",
      title: "Booking Policies",
      description:
        "Non-member hold, cancellation rules, minimum stays, and group discount.",
      status: complete ? "complete" : "warning",
      required: true,
      message: complete
        ? "Default booking policies are configured."
        : "Review booking policies before accepting live bookings.",
      details: [
        `Cancellation rules: ${db?.cancellationPolicyCount ?? 0}`,
        `Booking defaults: ${hasDefaults ? "configured" : "not configured"}`,
        `Group discount: ${db?.groupDiscountConfigured ? "configured" : "using defaults"}`,
      ],
      href: "/admin/booking-policies",
    },
    progress,
  );
}

function buildMembershipCancellationCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  if (!db) {
    return applyProgress(
      {
        id: "membership-cancellation",
        title: "Membership Cancellation",
        description:
          "Warning text, rejoin process text, and Xero cancellation handling.",
        status: "warning",
        required: false,
        message: "Membership cancellation settings were not checked.",
        details: [
          "Review this in /admin/setup/cancellation after migrations have run.",
        ],
        href: "/admin/setup/cancellation",
      },
      progress,
    );
  }

  return applyProgress(
    {
      id: "membership-cancellation",
      title: "Membership Cancellation",
      description:
        "Warning text, rejoin process text, and Xero cancellation handling.",
      status: db.membershipCancellationSettingsConfigured
        ? "complete"
        : "warning",
      required: false,
      message: db.membershipCancellationSettingsConfigured
        ? "Membership cancellation settings have been saved."
        : "Default membership cancellation settings are available; review and save club-specific copy before enabling requests.",
      details: [
        `Xero cancelled contact groups: ${db.membershipCancellationXeroGroupCount}`,
        `Archive cancelled Xero contacts: ${
          db.membershipCancellationArchiveContacts ? "enabled" : "disabled"
        }`,
      ],
      href: "/admin/setup/cancellation",
    },
    progress,
  );
}

function buildAgeTierCheck(
  club: ClubConfigReadResult,
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  if (!db) {
    return applyProgress(
      {
        id: "age-tiers",
        title: "Age And Membership Rules",
        description:
          "Age boundaries and whether each age tier needs a subscription to book.",
        status: "warning",
        required: true,
        message: "Database age-tier settings were not checked.",
        details: [
          "The CLI validated config age tiers; seeded database settings are checked in /admin/setup.",
        ],
        href: "/admin/age-tier-settings",
      },
      progress,
    );
  }

  // The DB is the sole runtime source of age tiers (#1983). Age tiers are
  // seeded / self-healed to the DB/seed contract, so the "expected" count comes
  // from that contract (AGE_TIER_DEFAULTS), not `config/club.json` — the file may
  // be absent once ageTiers[] is demoted to a seed-only input. When a primary
  // config is present its tier count still refines the expectation for forks
  // that configure a non-default number of tiers.
  const expected = club.config?.ageTiers.length ?? AGE_TIER_DEFAULTS.length;
  const actual = db?.ageTierSettingCount ?? 0;
  const complete = expected > 0 && actual >= expected;
  return applyProgress(
    {
      id: "age-tiers",
      title: "Age And Membership Rules",
      description:
        "Age boundaries and whether each age tier needs a subscription to book.",
      status: complete ? "complete" : "warning",
      required: true,
      message: complete
        ? "Database age-tier settings are populated."
        : "Seed or review age-tier settings before member imports.",
      details: [
        `Expected age tiers: ${expected || "unknown"}`,
        `Database age-tier settings: ${actual}`,
      ],
      href: "/admin/age-tier-settings",
    },
    progress,
  );
}

function buildSeasonRateCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  if (!db) {
    return applyProgress(
      {
        id: "seasons-rates",
        title: "Seasons And Rates",
        description:
          "Season windows and member/non-member nightly rates in integer cents.",
        status: "warning",
        required: true,
        message: "Database seasons and rates were not checked.",
        details: [
          "Run seed data or configure seasons from /admin/seasons after login.",
        ],
        href: "/admin/seasons",
      },
      progress,
    );
  }

  const seasonCount = db?.seasonCount ?? 0;
  const rateGaps = db?.membershipTypeRateGaps ?? [];
  const hasGaps = rateGaps.length > 0;
  const status: SetupStatus =
    seasonCount === 0 ? "blocked" : hasGaps ? "warning" : "complete";
  const MAX_LISTED_GAPS = 8;
  const gapDetails = hasGaps
    ? [
        `Membership types missing hut rates for an active or future season: ${rateGaps.length}`,
        ...rateGaps
          .slice(0, MAX_LISTED_GAPS)
          .map((gap) => `Missing rates: ${gap}`),
        ...(rateGaps.length > MAX_LISTED_GAPS
          ? [`…and ${rateGaps.length - MAX_LISTED_GAPS} more`]
          : []),
      ]
    : [];
  return applyProgress(
    {
      id: "seasons-rates",
      title: "Seasons And Rates",
      description:
        "Season windows and per-membership-type nightly rates in integer cents.",
      status,
      required: true,
      message:
        seasonCount === 0
          ? "At least one active season with rates is needed before bookings can price correctly."
          : hasGaps
            ? "Some membership types have no hut rates for an active or future season; bookings for them will fail at pricing until rates are set."
            : `${seasonCount} season${seasonCount === 1 ? "" : "s"} configured.`,
      details: [`Configured seasons: ${seasonCount}`, ...gapDetails],
      href: "/admin/seasons",
    },
    progress,
  );
}

function buildStripeCheck(
  env: Env,
  progress: SetupProgressState,
): SetupStepCheck {
  const issues = [
    !isLikelyStripeSecret(readEnv(env, "STRIPE_SECRET_KEY"))
      ? "STRIPE_SECRET_KEY is missing or has an unexpected prefix"
      : null,
    !isLikelyStripePublishable(
      readEnv(env, "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"),
    )
      ? "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is missing or has an unexpected prefix"
      : null,
    !hasEnv(env, "STRIPE_WEBHOOK_SECRET")
      ? "STRIPE_WEBHOOK_SECRET is missing"
      : null,
  ].filter((issue): issue is string => Boolean(issue));

  return applyProgress(
    {
      id: "stripe",
      title: "Stripe",
      description:
        "Card payments, saved payment methods, refunds, and webhooks.",
      status: issues.length === 0 ? "complete" : "blocked",
      required: true,
      message:
        issues.length === 0
          ? "Stripe environment variables are present."
          : "Stripe environment variables need attention.",
      details:
        issues.length === 0
          ? ["Secrets are set; values are not displayed."]
          : issues,
      href: "/admin/payments",
      action: {
        type: "provider-test",
        provider: "stripe",
        label: "Test Stripe",
      },
    },
    progress,
  );
}

function buildEmailCheck(
  env: Env,
  progress: SetupProgressState,
): SetupStepCheck {
  const emailDelivery = resolveEmailDeliveryConfigFromEnv(env);
  const issues = [...emailDelivery.issues];
  const details = [
    `Selected delivery mode: ${emailDelivery.modeLabel}`,
    ...emailDelivery.warnings.map((warning) => `Warning: ${warning}`),
  ];

  if (!hasEnv(env, "EMAIL_FROM")) {
    issues.push("EMAIL_FROM is missing");
  }

  if (emailDelivery.mode === "aws-ses" && !hasEnv(env, "SES_SNS_TOPIC_ARN")) {
    issues.push("SES_SNS_TOPIC_ARN is missing for deployed SES feedback");
  }

  if (issues.length === 0) {
    details.push("Secrets are set; values are not displayed.");
  }

  return applyProgress(
    {
      id: "email-ses",
      title: "Email Delivery",
      description:
        "Email sending via AWS SES or SMTP relay, plus optional SES SNS feedback.",
      status: issues.length === 0 ? "complete" : "blocked",
      required: true,
      message:
        issues.length === 0
          ? `Email delivery is configured (${emailDelivery.modeLabel}).`
          : `Email delivery setup needs attention (${emailDelivery.modeLabel}).`,
      details: issues.length === 0 ? details : [...details, ...issues],
      href: "/admin/health",
      action: {
        type: "provider-test",
        provider: "smtp",
        label: "Test Email",
      },
    },
    progress,
  );
}

function buildSentryCheck(
  env: Env,
  progress: SetupProgressState,
): SetupStepCheck {
  const missing = [
    "SENTRY_DSN",
    "NEXT_PUBLIC_SENTRY_DSN",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
  ].filter((name) => !hasEnv(env, name));

  return applyProgress(
    {
      id: "sentry",
      title: "Sentry",
      description:
        "Server, edge, browser error reporting, and source-map configuration.",
      status: missing.length === 0 ? "complete" : "warning",
      required: false,
      message:
        missing.length === 0
          ? "Sentry variables are present."
          : "Sentry can stay disabled, but production diagnostics will be limited.",
      details:
        missing.length === 0
          ? ["Sentry DSN/project variables are set; values are not displayed."]
          : missing.map((name) => `${name} is missing`),
      href: "/admin/health",
      action: {
        type: "provider-test",
        provider: "sentry",
        label: "Test Sentry",
      },
    },
    progress,
  );
}

function buildOperationalXeroCheck(
  env: Env,
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const moduleState = buildModuleLayerState(db, "xeroIntegration");
  const enabled = moduleState.effectiveEnabled;
  const issues = [
    !hasEnv(env, "XERO_CLIENT_ID") ? "XERO_CLIENT_ID is missing" : null,
    !hasEnv(env, "XERO_CLIENT_SECRET") ? "XERO_CLIENT_SECRET is missing" : null,
    !isHttpUrl(readEnv(env, "XERO_REDIRECT_URI"))
      ? "XERO_REDIRECT_URI must be a valid http(s) URL"
      : null,
    !isHexEncryptionKey(readEnv(env, "XERO_ENCRYPTION_KEY"))
      ? "XERO_ENCRYPTION_KEY must be a 64-character hex string"
      : null,
    !hasEnv(env, "XERO_WEBHOOK_KEY") ? "XERO_WEBHOOK_KEY is missing" : null,
  ].filter((issue): issue is string => Boolean(issue));
  const connected = Boolean(db?.operationalXeroConnected);

  return applyProgress(
    {
      id: "xero-operational",
      title: "Operational Xero",
      description:
        "Member/contact sync, invoices, payments, credit notes, and Xero webhooks.",
      status: !enabled
        ? "warning"
        : issues.length > 0
          ? "blocked"
          : !db
            ? "warning"
            : connected
              ? "complete"
              : "not_started",
      required: enabled,
      message: !enabled
        ? "Operational Xero is disabled in Admin Modules."
        : !db
          ? "Operational Xero env is ready; connection state was not checked."
          : connected
            ? "Operational Xero is connected."
            : issues.length > 0
              ? "Operational Xero env needs attention."
              : "Operational Xero env is ready; connect the tenant from admin.",
      details: [
        formatModuleActivationDetail(db, moduleState.adminEnabled),
        `Effective state: ${enabled ? "enabled" : "disabled"}`,
        ...issues,
        !db
          ? "Database connection state not checked."
          : connected
            ? `Token expires: ${db?.operationalXeroTokenExpiresAt ?? "unknown"}`
            : "No active operational Xero token found.",
      ],
      href: "/admin/xero",
      action: {
        type: "provider-test",
        provider: "xero",
        label: "Check Xero",
      },
    },
    progress,
  );
}

function buildAddressAutocompleteCheck(
  env: Env,
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const moduleState = buildModuleLayerState(db, "addressAutocomplete");
  const enabled = moduleState.effectiveEnabled;
  const missing = [
    !hasEnv(env, "ADDY_API_KEY") ? "ADDY_API_KEY is missing" : null,
    !hasEnv(env, "ADDY_API_SECRET") ? "ADDY_API_SECRET is missing" : null,
  ].filter((issue): issue is string => Boolean(issue));

  return applyProgress(
    {
      id: "address-autocomplete",
      title: "Address Autocomplete",
      description:
        "Optional Addy suggestions for address fields; manual entry remains available.",
      status: !enabled
        ? "warning"
        : missing.length > 0
          ? "blocked"
          : "complete",
      required: enabled,
      message: !enabled
        ? "Address autocomplete is disabled in Admin Modules; manual address entry remains available."
        : missing.length > 0
          ? "Address autocomplete is enabled but Addy credentials are missing."
          : "Address autocomplete is enabled and Addy credentials are configured.",
      details: [
        formatModuleActivationDetail(db, moduleState.adminEnabled),
        `Effective state: ${enabled ? "enabled" : "disabled"}`,
        ...(enabled ? missing : []),
        !enabled
          ? "ADDY_API_KEY and ADDY_API_SECRET are not required while the module is disabled."
          : missing.length === 0
            ? "Addy credentials are set; values are not displayed."
            : "Address forms can still be completed manually.",
      ],
      href: "/admin/modules",
    },
    progress,
  );
}

function buildFinanceDashboardCheck(
  env: Env,
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const moduleState = buildModuleLayerState(db, "financeDashboard");
  const enabled = moduleState.effectiveEnabled;
  const operationalConnected = Boolean(db?.operationalXeroConnected);

  return applyProgress(
    {
      id: "finance-dashboard",
      title: "Finance dashboard",
      description:
        "Finance reporting dashboards backed by the shared operational Xero connection.",
      status: !enabled
        ? "warning"
        : !db
          ? "warning"
          : operationalConnected
            ? "complete"
            : "not_started",
      required: enabled,
      message: !enabled
        ? "Finance dashboard is disabled in Admin Modules."
        : !db
          ? "Finance dashboard is enabled; Xero connection state was not checked."
          : operationalConnected
            ? "Finance dashboard is ready and the shared Xero connection is active."
            : "Finance dashboard is enabled; connect Xero from the admin Xero page so finance sync can run.",
      details: [
        formatModuleActivationDetail(db, moduleState.adminEnabled),
        `Effective state: ${enabled ? "enabled" : "disabled"}`,
        `Finance reporting reads from the shared operational Xero connection (requires ${XERO_REQUIRED_REPORT_OAUTH_SCOPES.join(", ")}).`,
        !db
          ? "Database connection state not checked."
          : operationalConnected
            ? "Operational Xero is connected; run a finance sync to load reporting data."
            : "No active Xero token found. Connect Xero from the admin Xero page.",
      ],
      href: "/finance",
    },
    progress,
  );
}

function buildXeroMappingCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  if (!db) {
    return applyProgress(
      {
        id: "xero-mappings",
        title: "Xero Mappings",
        description:
          "Chart of accounts, hut fee item codes, and joining-fee categories.",
        status: "warning",
        required: false,
        message: "Xero mapping database state was not checked.",
        details: ["Review mappings from /admin/xero after connecting Xero."],
        href: "/admin/xero#xero-section-mappings",
      },
      progress,
    );
  }

  const accountMappings = db?.xeroAccountMappingCount ?? 0;
  const hutFeeMappings = db?.xeroHutFeeItemMappingCount ?? 0;
  const entranceFeeMappings = db?.xeroEntranceFeeMappingCount ?? 0;
  const complete =
    accountMappings > 0 && hutFeeMappings > 0 && entranceFeeMappings > 0;

  return applyProgress(
    {
      id: "xero-mappings",
      title: "Xero Mappings",
      description:
        "Chart of accounts, hut fee item codes, and joining-fee categories.",
      status: complete ? "complete" : "warning",
      required: false,
      message: complete
        ? "Xero account and item mappings are configured."
        : "Map Xero accounts and item codes before using live Xero sync.",
      details: [
        `Account mappings: ${accountMappings}`,
        `Hut fee item mappings: ${hutFeeMappings}`,
        `Joining fee mappings: ${entranceFeeMappings}`,
      ],
      href: "/admin/xero#xero-section-mappings",
    },
    progress,
  );
}

export function buildSetupReadiness(
  input: {
    env?: Env;
    configDir?: string;
    database?: SetupDatabaseSnapshot;
    progress?: Partial<SetupProgressState> | null;
    now?: Date;
  } = {},
): SetupReadiness {
  const env = input.env ?? process.env;
  const configDir = input.configDir ?? path.join(process.cwd(), "config");
  const progress = normalizeSetupProgress(input.progress);
  const club = readClubConfig(configDir);

  const checksByCategory: Record<SetupCategoryId, SetupStepCheck[]> = {
    foundation: [
      buildClubConfigCheck(club, progress),
      buildRuntimeEnvCheck(env, progress),
      buildSeedAdminCheck(input.database, progress),
      buildFeatureFlagCheck(input.database, progress),
    ],
    booking: [
      buildBookingPolicyCheck(input.database, progress),
      buildMembershipCancellationCheck(input.database, progress),
      buildAgeTierCheck(club, input.database, progress),
      buildSeasonRateCheck(input.database, progress),
    ],
    integrations: [
      buildStripeCheck(env, progress),
      buildEmailCheck(env, progress),
      buildSentryCheck(env, progress),
      buildAddressAutocompleteCheck(env, input.database, progress),
      buildOperationalXeroCheck(env, input.database, progress),
    ],
    finance: [
      buildFinanceDashboardCheck(env, input.database, progress),
      buildXeroMappingCheck(input.database, progress),
    ],
  };

  const categories = CATEGORY_ORDER.map((id) => {
    const checks = checksByCategory[id];
    return {
      id,
      ...CATEGORY_META[id],
      status: worstStatus(unresolvedStatuses(checks)),
      checks,
    };
  });
  const allChecks = categories.flatMap((category) => category.checks);
  const skipped = allChecks.filter(
    (check) => check.progress === "skipped",
  ).length;
  const complete = allChecks.filter(
    (check) => check.status === "complete" || check.progress === "completed",
  ).length;
  const unresolved = allChecks.filter((check) => !isResolvedByProgress(check));
  const warning = unresolved.filter(
    (check) => check.status === "warning",
  ).length;
  const blocked = unresolved.filter(
    (check) => check.status === "blocked",
  ).length;

  return {
    status: worstStatus(unresolved.map((check) => check.status)),
    summary: {
      total: allChecks.length,
      complete,
      warning,
      blocked,
      skipped,
    },
    categories,
    generatedAt: (input.now ?? new Date()).toISOString(),
  };
}

export function renderSetupCheckReport(readiness: SetupReadiness): string {
  const lines = [
    `Setup readiness: ${readiness.status}`,
    `Complete ${readiness.summary.complete}/${readiness.summary.total}, warnings ${readiness.summary.warning}, blocked ${readiness.summary.blocked}, skipped ${readiness.summary.skipped}`,
    "",
  ];

  for (const category of readiness.categories) {
    lines.push(`${category.title} (${category.status})`);
    for (const check of category.checks) {
      const progressLabel =
        check.progress === "open" ? "" : `, ${check.progress}`;
      lines.push(
        `- ${check.title}: ${check.status}${progressLabel} - ${check.message}`,
      );
      for (const detail of check.details) {
        lines.push(`  ${detail}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function getSetupRequiredEnvNames(): string[] {
  return [
    ...REQUIRED_RUNTIME_ENV,
    "AUTH_SECRET or NEXTAUTH_SECRET",
    "STRIPE_SECRET_KEY",
    "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "USE_AWS_SES",
    "USE_SMTP_RELAY",
    "SMTP_HOST",
    "SMTP_PORT",
    "AWS_SES_ACCESS_KEY_ID",
    "AWS_SES_SECRET_ACCESS_KEY",
    "EMAIL_SERVER_HOST",
    "EMAIL_SERVER_PORT",
    "EMAIL_SERVER_USER",
    "EMAIL_SERVER_PASSWORD",
    "SES_SNS_TOPIC_ARN",
    "EMAIL_FROM",
    "SENTRY_DSN",
    "NEXT_PUBLIC_SENTRY_DSN",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
    "XERO_CLIENT_ID",
    "XERO_CLIENT_SECRET",
    "XERO_REDIRECT_URI",
    "XERO_ENCRYPTION_KEY",
    "XERO_WEBHOOK_KEY",
  ];
}
