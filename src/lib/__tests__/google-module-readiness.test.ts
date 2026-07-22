import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODULE_SETTINGS } from "@/config/modules";
import { buildClubModuleSettingsPayload } from "@/lib/module-settings";

// Readiness surfacing for the googleLogin module (#2035, DB-only since #2087):
// credentials live in the encrypted C1 store and the module cannot be turned ON
// until a real OAuth verify passes (the enable-gate in PUT /api/admin/modules),
// so an ENABLED googleLogin is already configured + verified — readiness no
// longer reads GOOGLE_CLIENT_* env vars. Enabled ⇒ ready; disabled ⇒
// admin_disabled. Never leaks secret values.
function googleStatus(
  settings = { ...DEFAULT_MODULE_SETTINGS, googleLogin: true },
) {
  const payload = buildClubModuleSettingsPayload(settings);
  return payload.modules.find((m) => m.key === "googleLogin")!;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("googleLogin module readiness (DB-only, #2087)", () => {
  it("is ready when enabled — independent of GOOGLE_CLIENT_* env", () => {
    // Legacy env vars are ignored now; they must not flip readiness either way.
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    const google = googleStatus();
    expect(google.readiness.status).toBe("ready");
    // No secret material ever appears in the payload.
    expect(JSON.stringify(google)).not.toContain("GOOGLE_CLIENT");
  });

  it("is admin_disabled when the module is off", () => {
    const google = googleStatus({
      ...DEFAULT_MODULE_SETTINGS,
      googleLogin: false,
    });
    expect(google.readiness.status).toBe("admin_disabled");
  });

  it("defaults googleLogin OFF for a fresh install", () => {
    expect(DEFAULT_MODULE_SETTINGS.googleLogin).toBe(false);
  });
});
