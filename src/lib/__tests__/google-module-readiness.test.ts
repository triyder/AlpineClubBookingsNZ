import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODULE_SETTINGS } from "@/config/modules";
import { buildClubModuleSettingsPayload } from "@/lib/module-settings";

// Readiness surfacing for the googleLogin module (#2035): mirrors the analytics
// `credentials_missing` pattern — enabled-without-credentials warns; disabled is
// admin_disabled; enabled-with-both-secrets is ready. Never leaks secret values.
function googleStatus(
  settings = { ...DEFAULT_MODULE_SETTINGS, googleLogin: true },
) {
  const payload = buildClubModuleSettingsPayload(settings);
  return payload.modules.find((m) => m.key === "googleLogin")!;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("googleLogin module readiness", () => {
  it("is credentials_missing when enabled without both secrets", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "some-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    const google = googleStatus();
    expect(google.readiness.status).toBe("credentials_missing");
    expect(JSON.stringify(google)).not.toContain("some-id");
  });

  it("is ready when enabled with both secrets configured", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "some-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "some-secret");
    expect(googleStatus().readiness.status).toBe("ready");
  });

  it("is admin_disabled when the module is off", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "some-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "some-secret");
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
