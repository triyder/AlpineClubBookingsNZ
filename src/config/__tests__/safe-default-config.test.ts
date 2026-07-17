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
    vi.unstubAllEnvs();
  });

  it("imports without throwing and resolves the five collapsing fields from the safe default (C6 #1985)", async () => {
    vi.resetModules();
    // NEXTAUTH_URL unset → the bootstrap public URL falls to the safe default,
    // never club.json. Mock provides BOTH clubConfig and SAFE_DEFAULT_CONFIG
    // because club-identity now imports the safe default for the collapsing
    // fields (publicUrl/emails/from-name/social links).
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.doMock("@/config/club", () => ({
      clubConfig: SAFE_DEFAULT_CONFIG,
      SAFE_DEFAULT_CONFIG,
    }));

    const mod = await import("@/config/club-identity");

    expect(mod.CLUB_PUBLIC_URL).toBe(SAFE_DEFAULT_CONFIG.publicUrl);
    expect(mod.clubIdentity.publicHost).toBe(
      new URL(SAFE_DEFAULT_CONFIG.publicUrl).host,
    );
    // The bootstrap email/identity fields resolve from the safe default, never
    // a synchronous club.json read.
    expect(mod.CLUB_SUPPORT_EMAIL).toBe(SAFE_DEFAULT_CONFIG.supportEmail);
    expect(mod.CLUB_CONTACT_EMAIL).toBe(SAFE_DEFAULT_CONFIG.contactEmail);
    expect(mod.CLUB_EMAIL_FROM_NAME).toBe(SAFE_DEFAULT_CONFIG.emailFromName);
    expect(mod.clubIdentity.socialLinks).toEqual({});
    expect(mod.CLUB_NAME).toBe(SAFE_DEFAULT_CONFIG.name);
  });

  it("prefers a valid NEXTAUTH_URL origin for the bootstrap public URL/host", async () => {
    vi.resetModules();
    vi.stubEnv("NEXTAUTH_URL", "https://bookings.myclub.nz/");
    vi.doMock("@/config/club", () => ({
      clubConfig: SAFE_DEFAULT_CONFIG,
      SAFE_DEFAULT_CONFIG,
    }));

    const mod = await import("@/config/club-identity");

    expect(mod.CLUB_PUBLIC_URL).toBe("https://bookings.myclub.nz");
    expect(mod.clubIdentity.publicHost).toBe("bookings.myclub.nz");
  });
});
