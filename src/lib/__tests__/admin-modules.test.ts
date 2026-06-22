import { describe, expect, it, vi } from "vitest";
import {
  getEffectiveModuleState,
  loadAdminModuleSettings,
  normalizeAdminModuleSettings,
} from "@/lib/admin-modules";
import { DEFAULT_MODULE_SETTINGS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

// All modules on. Derived from DEFAULT_MODULE_SETTINGS (every module defaults
// true) so these fixtures cover every module key and never drift when new
// modules are added.
const allCapabilitiesOn: FeatureFlags = { ...DEFAULT_MODULE_SETTINGS };

describe("Admin Modules effective state", () => {
  it("defaults missing module settings to active for upgrade-safe fallback", () => {
    expect(normalizeAdminModuleSettings(null)).toEqual(DEFAULT_MODULE_SETTINGS);
  });

  it("keeps env capability as the upper bound", () => {
    expect(
      getEffectiveModuleState(
        { ...allCapabilitiesOn, waitlist: false },
        { ...allCapabilitiesOn, waitlist: true },
      )
    ).toEqual({
      ...allCapabilitiesOn,
      waitlist: false,
    });
  });

  it("lets Admin Modules disable an env-capable module", () => {
    expect(
      getEffectiveModuleState(allCapabilitiesOn, {
        ...allCapabilitiesOn,
        xeroIntegration: false,
      })
    ).toEqual({
      ...allCapabilitiesOn,
      xeroIntegration: false,
    });
  });

  it("loads persisted module settings through the default row", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      kiosk: true,
      chores: false,
      financeDashboard: true,
      waitlist: false,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: true,
    });

    await expect(
      loadAdminModuleSettings({
        clubModuleSettings: {
          findUnique,
        },
      })
      // Persisted row only sets the original 7 keys; newer modules fall back to
      // their defaults (on).
    ).resolves.toEqual({
      ...DEFAULT_MODULE_SETTINGS,
      chores: false,
      waitlist: false,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
    });
  });

  it("falls back to active defaults if persisted settings cannot be read", async () => {
    await expect(
      loadAdminModuleSettings({
        clubModuleSettings: {
          findUnique: vi.fn().mockRejectedValue(new Error("database unavailable")),
        },
      })
    ).resolves.toEqual(DEFAULT_MODULE_SETTINGS);
  });
});
