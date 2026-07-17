import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SETUP_STEP_IDS,
  buildSetupReadiness,
  normalizeSetupProgress,
  renderSetupCheckReport,
  type SetupDatabaseSnapshot,
} from "@/lib/setup-readiness";

const baseEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
  NEXTAUTH_URL: "https://club.example.org",
  AUTH_SECRET: "auth-secret",
  CRON_SECRET: "cron-secret",
  SEED_ADMIN_EMAIL: "admin@example.org",
  SEED_ADMIN_PASSWORD: "change-me",
  STRIPE_SECRET_KEY: "sk_test_123",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_123",
  SMTP_HOST: "email-smtp.ap-southeast-2.amazonaws.com",
  SMTP_PORT: "587",
  AWS_SES_ACCESS_KEY_ID: "smtp-user",
  AWS_SES_SECRET_ACCESS_KEY: "smtp-secret",
  SES_SNS_TOPIC_ARN: "arn:aws:sns:ap-southeast-2:123456789012:ses",
  EMAIL_FROM: "bookings@example.org",
  SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
  NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
  SENTRY_ORG: "example",
  SENTRY_PROJECT: "bookings",
  XERO_CLIENT_ID: "xero-client",
  XERO_CLIENT_SECRET: "xero-secret",
  XERO_REDIRECT_URI: "https://club.example.org/api/admin/xero/callback",
  XERO_ENCRYPTION_KEY: "a".repeat(64),
  XERO_WEBHOOK_KEY: "webhook-key",
  ADDY_API_KEY: "addy-key",
  ADDY_API_SECRET: "addy-secret",
};

const completeDatabase: SetupDatabaseSnapshot = {
  adminCount: 1,
  adminModuleSettings: {
    kiosk: true,
    chores: true,
    financeDashboard: true,
    waitlist: true,
    xeroIntegration: true,
    bedAllocation: true,
    internetBankingPayments: true,
    addressAutocomplete: true,
    groupBookings: true,
    lockers: true,
    induction: true,
    workParties: true,
    promoCodes: true,
    hutLeaders: true,
    communications: true,
    skifieldConditions: true,
    twoFactor: false,
    analytics: false,
    lobbyDisplay: false,
  },
  ageTierSettingCount: 4,
  seasonCount: 2,
  cancellationPolicyCount: 3,
  bookingDefaultsConfigured: true,
  groupDiscountConfigured: true,
  membershipCancellationSettingsConfigured: true,
  membershipCancellationXeroGroupCount: 1,
  membershipCancellationArchiveContacts: false,
  operationalXeroConnected: true,
  operationalXeroTokenExpiresAt: "2026-06-01T00:00:00.000Z",
  xeroAccountMappingCount: 5,
  xeroHutFeeItemMappingCount: 16,
  xeroEntranceFeeMappingCount: 4,
};

const validClubConfig = {
  name: "Example Mountain Club",
  shortName: "EMC",
  supportEmail: "support@example.org",
  contactEmail: "bookings@example.org",
  publicUrl: "https://club.example.org",
  emailFromName: "Example Mountain Club - Online Booking System",
  beds: [{ id: "lodge", name: "Main Lodge", capacity: 20, type: "dormitory" }],
  ageTiers: [
    {
      id: "INFANT",
      label: "Infant",
      minAge: 0,
      maxAge: 4,
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      nightlyRates: {
        winter: { memberCents: 0, nonMemberCents: 0 },
        summer: { memberCents: 0, nonMemberCents: 0 },
      },
    },
    {
      id: "CHILD",
      label: "Child",
      minAge: 5,
      maxAge: 9,
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      nightlyRates: {
        winter: { memberCents: 1500, nonMemberCents: 2500 },
        summer: { memberCents: 1000, nonMemberCents: 2000 },
      },
    },
    {
      id: "YOUTH",
      label: "Youth",
      minAge: 10,
      maxAge: 17,
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: false,
      nightlyRates: {
        winter: { memberCents: 3000, nonMemberCents: 4500 },
        summer: { memberCents: 2500, nonMemberCents: 3500 },
      },
    },
    {
      id: "ADULT",
      label: "Adult",
      minAge: 18,
      maxAge: null,
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: false,
      nightlyRates: {
        winter: { memberCents: 4500, nonMemberCents: 6500 },
        summer: { memberCents: 3500, nonMemberCents: 5000 },
      },
    },
  ],
};

const tempDirs: string[] = [];

function makeConfigDir(config: unknown = validClubConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-readiness-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "club.json"), JSON.stringify(config, null, 2));
  return dir;
}

describe("setup-readiness", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a complete setup without exposing secret values", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: completeDatabase,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(readiness.status).toBe("complete");
    expect(readiness.summary.blocked).toBe(0);
    expect(JSON.stringify(readiness)).not.toContain("sk_test_123");
    expect(JSON.stringify(readiness)).not.toContain("smtp-secret");
    expect(JSON.stringify(readiness)).not.toContain("xero-secret");
    expect(JSON.stringify(readiness)).not.toContain("addy-secret");

    const report = renderSetupCheckReport(readiness);
    expect(report).toContain("accounting.reports.profitandloss.read");
    expect(report).toContain("accounting.reports.balancesheet.read");
    expect(report).toContain("accounting.reports.banksummary.read");
    expect(report).not.toContain("accounting.reports.read");
  });

  it("drops the Seasons And Rates step to a warning when a membership type has rate gaps (#1930, E4)", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        membershipTypeRateGaps: [
          "Club — Winter 2026 (missing INFANT, CHILD)",
          "School Group — Winter 2026 (missing flat all-ages rate)",
        ],
      },
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    const bookingCategory = readiness.categories.find((c) => c.id === "booking");
    const seasonsCheck = bookingCategory?.checks.find(
      (check) => check.id === "seasons-rates",
    );
    expect(seasonsCheck?.status).toBe("warning");
    expect(seasonsCheck?.message).toContain("no hut rates");
    expect(seasonsCheck?.details).toContain(
      "Missing rates: Club — Winter 2026 (missing INFANT, CHILD)",
    );
    expect(seasonsCheck?.details).toContain(
      "Missing rates: School Group — Winter 2026 (missing flat all-ages rate)",
    );
    expect(readiness.status).toBe("warning");
  });

  it("computes tier-aware membership-type rate gaps (#1930, E4 review F7)", async () => {
    const { computeMembershipTypeRateGaps } = await import("@/lib/setup-readiness");
    const types = [
      { id: "type-full", name: "Full Member", ageGroupsApply: true },
      { id: "type-club", name: "Club", ageGroupsApply: true },
      { id: "type-flat-covered", name: "Flat Fallback", ageGroupsApply: true },
      { id: "type-school", name: "School Group", ageGroupsApply: false },
      { id: "type-school-bad", name: "School (misconfigured)", ageGroupsApply: false },
    ];
    const seasons = [{ id: "s-1", name: "Winter 2026" }];
    const rateRows = [
      // Full: complete per-tier coverage — no gap.
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "INFANT" },
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "CHILD" },
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "YOUTH" },
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "ADULT" },
      // Club: PARTIAL tier coverage, no flat row — a booking for a missing
      // tier hard-throws, so this is a gap (the pre-fix pair-existence check
      // missed exactly this case).
      { seasonId: "s-1", membershipTypeId: "type-club", ageTier: "ADULT" },
      { seasonId: "s-1", membershipTypeId: "type-club", ageTier: "YOUTH" },
      // Flat Fallback: age-keyed type covered entirely by its flat row (the
      // engine falls back exact-tier -> flat) — no gap.
      { seasonId: "s-1", membershipTypeId: "type-flat-covered", ageTier: null },
      // School Group: flat type with its flat row — no gap.
      { seasonId: "s-1", membershipTypeId: "type-school", ageTier: null },
      // School (misconfigured): flat type with ONLY tier rows — shape anomaly,
      // flagged as missing its flat rate.
      { seasonId: "s-1", membershipTypeId: "type-school-bad", ageTier: "ADULT" },
    ];

    const gaps = computeMembershipTypeRateGaps({ types, seasons, rateRows });
    expect(gaps).toEqual([
      "Club — Winter 2026 (missing INFANT, CHILD)",
      "School (misconfigured) — Winter 2026 (missing flat all-ages rate)",
    ]);

    // A type with NO rows at all for a season is a gap listing every tier.
    const emptyGaps = computeMembershipTypeRateGaps({
      types: [{ id: "type-new", name: "New Type", ageGroupsApply: true }],
      seasons,
      rateRows: [],
    });
    expect(emptyGaps).toEqual([
      "New Type — Winter 2026 (missing INFANT, CHILD, YOUTH, ADULT)",
    ]);
  });

  it("surfaces missing first-boot inputs as blocked checks", () => {
    const readiness = buildSetupReadiness({
      env: {},
      configDir: makeConfigDir({ ...validClubConfig, supportEmail: "not-an-email" }),
      database: { ...completeDatabase, adminCount: 0, seasonCount: 0 },
    });

    expect(readiness.status).toBe("blocked");
    expect(readiness.summary.blocked).toBeGreaterThan(0);

    const report = renderSetupCheckReport(readiness);
    expect(report).toContain("Runtime Environment: blocked");
    expect(report).toContain("supportEmail");
    expect(report).toContain("Run the seed command");
  });

  it("reports module state from Admin Modules activation only", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        adminModuleSettings: {
          ...completeDatabase.adminModuleSettings!,
          xeroIntegration: false,
          financeDashboard: false,
        },
        operationalXeroConnected: false,
      },
    });

    const report = renderSetupCheckReport(readiness);

    expect(report).toContain("Operational Xero Admin Modules activation: disabled");
    expect(report).toContain("Operational Xero is disabled in Admin Modules.");
    expect(report).toContain("Finance dashboard Admin Modules activation: disabled");
    expect(report).toContain("Finance dashboard is disabled in Admin Modules.");
    expect(report).toContain("Address autocomplete Admin Modules activation: enabled");
    expect(report).not.toContain("env capability");
  });

  it("distinguishes address autocomplete disabled, missing credentials, and ready states", () => {
    const disabled = buildSetupReadiness({
      env: {},
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        adminModuleSettings: {
          ...completeDatabase.adminModuleSettings!,
          addressAutocomplete: false,
        },
      },
    });
    const disabledReport = renderSetupCheckReport(disabled);
    expect(disabledReport).toContain(
      "Address Autocomplete: warning - Address autocomplete is disabled in Admin Modules; manual address entry remains available.",
    );
    expect(disabledReport).toContain(
      "ADDY_API_KEY and ADDY_API_SECRET are not required while the module is disabled.",
    );

    const missingCredentials = buildSetupReadiness({
      env: {
        ...baseEnv,
        ADDY_API_KEY: undefined,
        ADDY_API_SECRET: undefined,
      },
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        adminModuleSettings: {
          ...completeDatabase.adminModuleSettings!,
          addressAutocomplete: true,
        },
      },
    });
    const missingReport = renderSetupCheckReport(missingCredentials);
    expect(missingReport).toContain(
      "Address Autocomplete: blocked - Address autocomplete is enabled but Addy credentials are missing.",
    );
    expect(missingReport).toContain("ADDY_API_KEY is missing");
    expect(missingReport).toContain("ADDY_API_SECRET is missing");

    const ready = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        adminModuleSettings: {
          ...completeDatabase.adminModuleSettings!,
          addressAutocomplete: true,
        },
      },
    });
    const readyReport = renderSetupCheckReport(ready);
    expect(readyReport).toContain(
      "Address Autocomplete: complete - Address autocomplete is enabled and Addy credentials are configured.",
    );
    expect(readyReport).not.toContain("addy-secret");
  });

  it("treats acknowledged not-started checks as resolved for overall readiness", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        operationalXeroConnected: false,
        operationalXeroTokenExpiresAt: null,
      },
      progress: {
        completedStepIds: [...SETUP_STEP_IDS],
        skippedStepIds: [],
      },
    });

    expect(readiness.status).toBe("complete");
    expect(readiness.summary.complete).toBe(readiness.summary.total);
    expect(readiness.summary.blocked).toBe(0);
    expect(readiness.summary.warning).toBe(0);
    expect(readiness.summary.skipped).toBe(0);
  });

  it("normalizes progress to known setup step ids", () => {
    expect(
      normalizeSetupProgress({
        completedStepIds: ["club-config", "unknown"],
        skippedStepIds: ["sentry", "unknown"],
        completedAt: "2026-05-18T00:00:00.000Z",
        completedByMemberId: "member_1",
      }),
    ).toEqual({
      completedStepIds: ["club-config"],
      skippedStepIds: ["sentry"],
      completedAt: "2026-05-18T00:00:00.000Z",
      completedByMemberId: "member_1",
    });
  });
});

describe("setup-readiness club-config reconcile (D3, epic #1943)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-readiness-d3-"));
    dirs.push(dir);
    return dir;
  }

  function clubConfigCheck(configDir: string) {
    const readiness = buildSetupReadiness({ configDir });
    for (const category of readiness.categories) {
      const check = category.checks.find((c) => c.id === "club-config");
      if (check) return check;
    }
    throw new Error("club-config check not found");
  }

  it("reports blocked for a malformed primary and does NOT fall through to a valid example", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "club.json"), "{ not json");
    fs.writeFileSync(
      path.join(dir, "club.example.json"),
      JSON.stringify({ ...validClubConfig, name: "Example Fallback" }, null, 2),
    );

    const check = clubConfigCheck(dir);
    expect(check.status).toBe("blocked");
    // Must not be silently satisfied by the example's identity.
    expect(check.message).not.toContain("Example Fallback");
  });

  it("reports blocked for a schema-invalid primary even when a valid example exists", () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, "club.json"),
      JSON.stringify({ ...validClubConfig, supportEmail: "garbage" }, null, 2),
    );
    fs.writeFileSync(
      path.join(dir, "club.example.json"),
      JSON.stringify(validClubConfig, null, 2),
    );

    expect(clubConfigCheck(dir).status).toBe("blocked");
  });

  it("reports complete for an absent primary with a valid example", () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, "club.example.json"),
      JSON.stringify({ ...validClubConfig, name: "Adopter Club" }, null, 2),
    );

    const check = clubConfigCheck(dir);
    expect(check.status).toBe("complete");
    expect(check.message).toContain("Adopter Club");
  });

  it("reports blocked when neither file exists", () => {
    expect(clubConfigCheck(makeDir()).status).toBe("blocked");
  });
});
