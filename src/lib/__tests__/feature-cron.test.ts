import { describe, expect, it } from "vitest";
import { getOptionalCronRegistrationState } from "@/instrumentation.node";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

const allModulesOn = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

describe("feature-aware cron registration", () => {
  it("registers optional cron groups even when their module state is off", () => {
    const flags: FeatureFlags = {
      ...allModulesOn,
      financeDashboard: false,
      waitlist: false,
      xeroIntegration: false,
    };

    expect(getOptionalCronRegistrationState(flags)).toEqual({
      financeDailySync: true,
      waitlistProcessor: true,
      xeroIntegration: true,
    });
  });

  it("registers optional cron groups when their module state is on", () => {
    expect(getOptionalCronRegistrationState(allModulesOn)).toEqual({
      financeDailySync: true,
      waitlistProcessor: true,
      xeroIntegration: true,
    });
  });
});
