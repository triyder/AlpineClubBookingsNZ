import { afterEach, describe, expect, it, vi } from "vitest";
import { clubConfigSchema } from "@/config/schema";
import { SAFE_DEFAULT_CONFIG } from "@/config/safe-default-config";

describe("SAFE_DEFAULT_CONFIG", () => {
  it("is a valid ClubConfig (passes clubConfigSchema)", () => {
    const result = clubConfigSchema.safeParse(SAFE_DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  it("has a valid absolute http(s) publicUrl so new URL() cannot throw at boot", () => {
    // Guards the src/config/club-identity.ts:24 boot-crash path.
    expect(() => new URL(SAFE_DEFAULT_CONFIG.publicUrl)).not.toThrow();
    const parsed = new URL(SAFE_DEFAULT_CONFIG.publicUrl);
    expect(["http:", "https:"]).toContain(parsed.protocol);
    expect(parsed.host).toBeTruthy();
  });

  it("is re-exported from @/config/club as the canonical constant (single source of truth)", async () => {
    const { SAFE_DEFAULT_CONFIG: viaClub } = await import("@/config/club");
    expect(viaClub).toBe(SAFE_DEFAULT_CONFIG);
  });
});

describe("club-identity under SAFE_DEFAULT_CONFIG", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/config/club");
  });

  it("imports without throwing and resolves publicHost from the safe default", async () => {
    vi.resetModules();
    vi.doMock("@/config/club", () => ({ clubConfig: SAFE_DEFAULT_CONFIG }));

    const mod = await import("@/config/club-identity");

    expect(mod.CLUB_PUBLIC_URL).toBe(SAFE_DEFAULT_CONFIG.publicUrl);
    expect(mod.clubIdentity.publicHost).toBe(
      new URL(SAFE_DEFAULT_CONFIG.publicUrl).host,
    );
    expect(mod.CLUB_NAME).toBe(SAFE_DEFAULT_CONFIG.name);
  });
});
