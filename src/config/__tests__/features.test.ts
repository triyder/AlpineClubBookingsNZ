import { describe, expect, it } from "vitest";
import { loadFeatureFlags } from "@/config/features";

// The original capability flags default OFF (a deploy opts in with FEATURE_X=true).
const LEGACY_FLAGS_OFF = {
  kiosk: false,
  chores: false,
  financeDashboard: false,
  waitlist: false,
  xeroIntegration: false,
  bedAllocation: false,
  internetBankingPayments: false,
};

// The newer general-purpose feature modules default ON (a club opts out via the
// admin Modules page, or a deploy hard-disables with FEATURE_X=false).
const NEW_MODULES_ON = {
  groupBookings: true,
  lockers: true,
  induction: true,
  workParties: true,
  promoCodes: true,
  hutLeaders: true,
  communications: true,
  skifieldConditions: true,
};

describe("loadFeatureFlags", () => {
  it("defaults legacy capability flags OFF and feature modules ON with no env", () => {
    expect(loadFeatureFlags({})).toEqual({
      ...LEGACY_FLAGS_OFF,
      ...NEW_MODULES_ON,
    });
  });

  it("defaults every newer feature module to ON when its env var is unset", () => {
    const flags = loadFeatureFlags({});
    expect(flags.groupBookings).toBe(true);
    expect(flags.lockers).toBe(true);
    expect(flags.induction).toBe(true);
    expect(flags.workParties).toBe(true);
    expect(flags.promoCodes).toBe(true);
    expect(flags.hutLeaders).toBe(true);
    expect(flags.communications).toBe(true);
    expect(flags.skifieldConditions).toBe(true);
  });

  it("lets an explicit 'false' hard-disable a default-on module", () => {
    expect(loadFeatureFlags({ FEATURE_GROUP_BOOKINGS: "false" }).groupBookings).toBe(
      false,
    );
    expect(loadFeatureFlags({ FEATURE_LOCKERS: "FALSE" }).lockers).toBe(false);
    expect(loadFeatureFlags({ FEATURE_PROMO_CODES: "  false  " }).promoCodes).toBe(
      false,
    );
  });

  it("enables a legacy flag when its env var is exactly 'true'", () => {
    const flags = loadFeatureFlags({ FEATURE_KIOSK: "true" });
    expect(flags.kiosk).toBe(true);
  });

  it("accepts 'true' case-insensitively and with surrounding whitespace", () => {
    expect(loadFeatureFlags({ FEATURE_KIOSK: "TRUE" }).kiosk).toBe(true);
    expect(loadFeatureFlags({ FEATURE_KIOSK: "True" }).kiosk).toBe(true);
    expect(loadFeatureFlags({ FEATURE_KIOSK: "  true  " }).kiosk).toBe(true);
  });

  it("treats a garbage value as the flag's default (fail-safe)", () => {
    // Legacy flag defaults off, so non-true/false garbage stays off.
    for (const v of ["", "1", "0", "yes", "no", "on", "off", "True!"]) {
      expect(loadFeatureFlags({ FEATURE_KIOSK: v }).kiosk).toBe(false);
    }
    // A newer module defaults on, so the same garbage stays on.
    for (const v of ["", "1", "yes", "True!"]) {
      expect(loadFeatureFlags({ FEATURE_LOCKERS: v }).lockers).toBe(true);
    }
  });

  it("maps each legacy flag to its dedicated env var", () => {
    const flags = loadFeatureFlags({
      FEATURE_KIOSK: "true",
      FEATURE_CHORES: "true",
      FEATURE_FINANCE_DASHBOARD: "true",
      FEATURE_WAITLIST: "true",
      FEATURE_XERO_INTEGRATION: "true",
      FEATURE_BED_ALLOCATION: "true",
      FEATURE_INTERNET_BANKING_PAYMENTS: "true",
    });
    expect(flags).toEqual({
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: true,
      ...NEW_MODULES_ON,
    });
  });

  it("ignores unrelated env vars", () => {
    const flags = loadFeatureFlags({
      FEATURE_UNKNOWN: "true",
      NODE_ENV: "test",
    });
    expect(flags.kiosk).toBe(false);
  });
});
