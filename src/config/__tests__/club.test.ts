import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadClubConfig, loadClubConfigWithSource, SAFE_DEFAULT_CONFIG } from "@/config/club";
import logger from "@/lib/logger";

const nightlyRates = {
  winter: { memberCents: 4500, nonMemberCents: 6500 },
  summer: { memberCents: 3500, nonMemberCents: 5000 },
};

const validConfig = {
  name: "Example Mountain Club",
  shortName: "EMC",
  supportEmail: "support@example.org",
  contactEmail: "bookings@example.org",
  publicUrl: "https://example.org",
  emailFromName: "Example Mountain Club - Online Booking System",
  beds: [
    { id: "lodge", name: "Main Lodge", capacity: 20, type: "dormitory" },
  ],
  ageTiers: [
    { id: "INFANT", label: "Infant", minAge: 0, maxAge: 4, subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, nightlyRates },
    { id: "ADULT", label: "Adult", minAge: 18, maxAge: null, subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, nightlyRates },
  ],
};

describe("loadClubConfig", () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "club-config-"));
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  function writeJson(name: string, data: unknown) {
    fs.writeFileSync(path.join(tmpDir, name), JSON.stringify(data, null, 2));
  }

  it("loads and validates club.json when present", () => {
    writeJson("club.json", validConfig);
    const cfg = loadClubConfig({ configDir: tmpDir });
    expect(cfg.name).toBe("Example Mountain Club");
    expect(cfg.beds[0].capacity).toBe(20);
  });

  it("returns a valid club.json byte-for-byte unchanged (zero behaviour change for healthy installs)", () => {
    writeJson("club.json", validConfig);
    const cfg = loadClubConfig({ configDir: tmpDir });
    expect(cfg).toEqual(validConfig);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to club.example.json when club.json is absent", () => {
    writeJson("club.example.json", {
      ...validConfig,
      name: "Fallback Club",
    });
    const cfg = loadClubConfig({ configDir: tmpDir });
    expect(cfg.name).toBe("Fallback Club");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("prefers club.json over club.example.json when both exist", () => {
    writeJson("club.json", { ...validConfig, name: "Primary" });
    writeJson("club.example.json", { ...validConfig, name: "Example" });
    const cfg = loadClubConfig({ configDir: tmpDir });
    expect(cfg.name).toBe("Primary");
  });

  it("returns the example config so an outside adopter can boot with only the example", () => {
    writeJson("club.example.json", validConfig);
    expect(() => loadClubConfig({ configDir: tmpDir })).not.toThrow();
  });

  // --- Boot-safety: the loader NEVER throws (epic #1943, child C1) ---

  it("resolves to SAFE_DEFAULT_CONFIG and warns when neither file exists (no throw)", () => {
    const cfg = loadClubConfig({ configDir: tmpDir });
    expect(cfg).toBe(SAFE_DEFAULT_CONFIG);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toMatch(/No club config found/);
  });

  it("resolves a malformed primary club.json to SAFE_DEFAULT_CONFIG and warns (no throw)", () => {
    fs.writeFileSync(path.join(tmpDir, "club.json"), "{ not json");
    const cfg = loadClubConfig({ configDir: tmpDir });
    expect(cfg).toBe(SAFE_DEFAULT_CONFIG);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toMatch(/Malformed club config/);
  });

  it("D3: a malformed primary SKIPS club.example.json (does not boot on the example identity)", () => {
    fs.writeFileSync(path.join(tmpDir, "club.json"), "{ not json");
    writeJson("club.example.json", { ...validConfig, name: "Example Fallback" });
    const cfg = loadClubConfig({ configDir: tmpDir });
    // Must NOT silently fall through to the example; resolves to the safe default.
    expect(cfg).toBe(SAFE_DEFAULT_CONFIG);
    expect(cfg.name).not.toBe("Example Fallback");
  });

  it("resolves a schema-invalid primary to SAFE_DEFAULT_CONFIG and warns (no throw)", () => {
    writeJson("club.json", { ...validConfig, supportEmail: "garbage" });
    const cfg = loadClubConfig({ configDir: tmpDir });
    expect(cfg).toBe(SAFE_DEFAULT_CONFIG);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toMatch(/supportEmail/);
  });

  it("resolves a primary with unknown top-level keys to SAFE_DEFAULT_CONFIG (no throw)", () => {
    writeJson("club.json", { ...validConfig, mystery: 1 });
    const cfg = loadClubConfig({ configDir: tmpDir });
    expect(cfg).toBe(SAFE_DEFAULT_CONFIG);
  });

  it("resolves to SAFE_DEFAULT_CONFIG when primary is absent and example is malformed", () => {
    fs.writeFileSync(path.join(tmpDir, "club.example.json"), "{ not json");
    const cfg = loadClubConfig({ configDir: tmpDir });
    expect(cfg).toBe(SAFE_DEFAULT_CONFIG);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  // --- Provenance: which branch resolved the config (drives the self-heal guard) ---

  it("reports provenance 'primary' for a valid club.json", () => {
    writeJson("club.json", validConfig);
    const { config, source } = loadClubConfigWithSource({ configDir: tmpDir });
    expect(source).toBe("primary");
    expect(config.name).toBe("Example Mountain Club");
  });

  it("reports provenance 'example' when primary is absent and the example is valid", () => {
    writeJson("club.example.json", { ...validConfig, name: "Fallback Club" });
    const { config, source } = loadClubConfigWithSource({ configDir: tmpDir });
    expect(source).toBe("example");
    expect(config.name).toBe("Fallback Club");
  });

  it("reports provenance 'safe-default' for a malformed primary", () => {
    fs.writeFileSync(path.join(tmpDir, "club.json"), "{ not json");
    const { config, source } = loadClubConfigWithSource({ configDir: tmpDir });
    expect(source).toBe("safe-default");
    expect(config).toBe(SAFE_DEFAULT_CONFIG);
  });

  it("reports provenance 'safe-default' for a schema-invalid primary", () => {
    writeJson("club.json", { ...validConfig, supportEmail: "garbage" });
    const { source } = loadClubConfigWithSource({ configDir: tmpDir });
    expect(source).toBe("safe-default");
  });

  it("reports provenance 'safe-default' when neither file exists", () => {
    const { config, source } = loadClubConfigWithSource({ configDir: tmpDir });
    expect(source).toBe("safe-default");
    expect(config).toBe(SAFE_DEFAULT_CONFIG);
  });
});
