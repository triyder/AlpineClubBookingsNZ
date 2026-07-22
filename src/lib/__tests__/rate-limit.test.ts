import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit as checkSharedRateLimit,
  checkRateLimitInMemory as checkRateLimit,
  getClientIp,
  applyRateLimit,
  rateLimiters,
  _testStore,
  type RateLimitConfig,
} from "../rate-limit";

// Shared-store path (#1039 item 4): prisma is mocked so the atomic upsert
// can be scripted; the fallback test rejects it to prove degradation.
const mockQueryRaw = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
    $executeRaw: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe("rate-limit", () => {
  beforeEach(() => {
    _testStore.clear();
  });

  describe("checkRateLimit", () => {
    const config: RateLimitConfig = {
      id: "test",
      limit: 3,
      windowSeconds: 60,
    };

    it("allows requests within the limit", () => {
      const r1 = checkRateLimit(config, "ip1");
      expect(r1.success).toBe(true);
      expect(r1.remaining).toBe(2);

      const r2 = checkRateLimit(config, "ip1");
      expect(r2.success).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = checkRateLimit(config, "ip1");
      expect(r3.success).toBe(true);
      expect(r3.remaining).toBe(0);
    });

    it("blocks requests exceeding the limit", () => {
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");

      const r4 = checkRateLimit(config, "ip1");
      expect(r4.success).toBe(false);
      expect(r4.remaining).toBe(0);
    });

    it("tracks different IPs independently", () => {
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");

      // ip2 should still be allowed
      const r = checkRateLimit(config, "ip2");
      expect(r.success).toBe(true);
      expect(r.remaining).toBe(2);
    });

    it("tracks different configs independently", () => {
      const config2: RateLimitConfig = { id: "test2", limit: 5, windowSeconds: 60 };

      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");

      // Different config, same IP should still be allowed
      const r = checkRateLimit(config2, "ip1");
      expect(r.success).toBe(true);
      expect(r.remaining).toBe(4);
    });

    it("resets after window expires", () => {
      // Manually set an expired entry
      _testStore.set("test:ip1", { count: 5, resetAt: Date.now() - 1000 });

      const r = checkRateLimit(config, "ip1");
      expect(r.success).toBe(true);
      expect(r.remaining).toBe(2);
    });

    it("returns correct resetAt timestamp", () => {
      const before = Date.now();
      const r = checkRateLimit(config, "ip1");
      const after = Date.now();

      expect(r.resetAt).toBeGreaterThanOrEqual(before + 60_000);
      expect(r.resetAt).toBeLessThanOrEqual(after + 60_000);
    });
  });

  describe("getClientIp", () => {
    it("extracts last IP from x-forwarded-for (rightmost = closest trusted proxy)", () => {
      const req = new Request("http://localhost", {
        headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      });
      expect(getClientIp(req)).toBe("5.6.7.8");
    });

    it("ignores a client-supplied leftmost x-forwarded-for value once Caddy appends the real peer", () => {
      const req = new Request("http://localhost", {
        headers: {
          "x-forwarded-for": "203.0.113.250, 198.51.100.42",
          "x-real-ip": "198.51.100.42",
        },
      });
      expect(getClientIp(req)).toBe("198.51.100.42");
    });

    it("extracts IP from x-real-ip", () => {
      const req = new Request("http://localhost", {
        headers: { "x-real-ip": "9.8.7.6" },
      });
      expect(getClientIp(req)).toBe("9.8.7.6");
    });

    it("returns unknown when no headers present", () => {
      const req = new Request("http://localhost");
      expect(getClientIp(req)).toBe("unknown");
    });

    it("prefers x-forwarded-for over x-real-ip", () => {
      const req = new Request("http://localhost", {
        headers: {
          "x-forwarded-for": "1.1.1.1",
          "x-real-ip": "2.2.2.2",
        },
      });
      expect(getClientIp(req)).toBe("1.1.1.1");
    });
  });

  describe("applyRateLimit", () => {
    const config: RateLimitConfig = { id: "apply-test", limit: 2, windowSeconds: 60 };

    it("returns null when within limit", async () => {
      const req = new Request("http://localhost", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      const result = await applyRateLimit(config, req);
      expect(result).toBeNull();
    });

    it("returns 429 Response when limit exceeded", async () => {
      const req = new Request("http://localhost", {
        headers: { "x-forwarded-for": "10.0.0.2" },
      });

      await applyRateLimit(config, req);
      await applyRateLimit(config, req);
      const result = await applyRateLimit(config, req);

      expect(result).not.toBeNull();
      expect(result!.status).toBe(429);
      expect(result!.headers.get("Retry-After")).toBeTruthy();
    });

    it("includes rate limit headers on 429", async () => {
      const req = new Request("http://localhost", {
        headers: { "x-forwarded-for": "10.0.0.3" },
      });

      await applyRateLimit(config, req);
      await applyRateLimit(config, req);
      const result = await applyRateLimit(config, req);

      expect(result!.headers.get("X-RateLimit-Limit")).toBe("2");
      expect(result!.headers.get("X-RateLimit-Remaining")).toBe("0");

      const body = await result!.json();
      expect(body.error).toContain("Too many requests");
    });
  });
});

describe("shared rate-limit store (#1039)", () => {
  const config = { id: "shared-test", limit: 2, windowSeconds: 60 };

  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it("allows and counts through the shared Postgres counter", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    mockQueryRaw.mockResolvedValueOnce([{ count: 1, resetAt }]);

    const result = await checkSharedRateLimit(config, "ip1");

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(1);
    expect(result.resetAt).toBe(resetAt.getTime());
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it("blocks once the shared counter exceeds the limit", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    mockQueryRaw.mockResolvedValueOnce([{ count: 3, resetAt }]);

    const result = await checkSharedRateLimit(config, "ip1");

    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("falls back to per-process limiting when the store is unavailable", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));

    const r1 = await checkSharedRateLimit(config, "fallback-ip");
    const r2 = await checkSharedRateLimit(config, "fallback-ip");
    const r3 = await checkSharedRateLimit(config, "fallback-ip");

    // The in-memory window still enforces the limit per process.
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(false);
  });
});

describe("degraded-mode policy for auth-sensitive limiters (#1142)", () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it("shrinks the fallback budget to limit/4 for auth-sensitive limiters", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));
    const config = {
      id: "degraded-auth-test",
      limit: 8,
      windowSeconds: 60,
      authSensitive: true,
    };

    // floor(8 / 4) = 2 allowed, third rejected.
    const r1 = await checkSharedRateLimit(config, "attacker-ip");
    const r2 = await checkSharedRateLimit(config, "attacker-ip");
    const r3 = await checkSharedRateLimit(config, "attacker-ip");

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(false);
    expect(r3.limit).toBe(2);
  });

  it("never shrinks the degraded budget below one request", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));
    const config = {
      id: "degraded-floor-test",
      limit: 3,
      windowSeconds: 60,
      authSensitive: true,
    };

    // floor(3 / 4) = 0, floored to 1 so legitimate users are not locked out.
    const r1 = await checkSharedRateLimit(config, "member-ip");
    const r2 = await checkSharedRateLimit(config, "member-ip");

    expect(r1.success).toBe(true);
    expect(r1.limit).toBe(1);
    expect(r2.success).toBe(false);
  });

  it("keeps the full budget for non-sensitive limiters in degraded mode", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));
    const config = { id: "degraded-plain-test", limit: 8, windowSeconds: 60 };

    for (let i = 0; i < 8; i += 1) {
      const r = await checkSharedRateLimit(config, "reader-ip");
      expect(r.success).toBe(true);
    }
    const r9 = await checkSharedRateLimit(config, "reader-ip");
    expect(r9.success).toBe(false);
    expect(r9.limit).toBe(8);
  });

  it("applies the full budget when the shared store is healthy, even for auth-sensitive limiters", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    mockQueryRaw.mockResolvedValueOnce([{ count: 8, resetAt }]);
    const config = {
      id: "healthy-auth-test",
      limit: 8,
      windowSeconds: 60,
      authSensitive: true,
    };

    const result = await checkSharedRateLimit(config, "ip1");

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("does not shrink direct in-memory checks that are not degraded fallbacks", () => {
    const config = {
      id: "direct-memory-auth-test",
      limit: 8,
      windowSeconds: 60,
      authSensitive: true,
    };

    for (let i = 0; i < 8; i += 1) {
      expect(checkRateLimit(config, "ip1").success).toBe(true);
    }
    expect(checkRateLimit(config, "ip1").success).toBe(false);
  });

  it("marks every credential-guessing and public-form limiter as auth-sensitive", () => {
    const expected = [
      "login",
      "register",
      "membershipApplication",
      "forgotPassword",
      // Magic-link sign-in request (#2034): credential-adjacent public form,
      // mirrors forgotPassword's degraded-mode budget hardening.
      "magicLinkRequest",
      "resetPassword",
      "lodgePinLogin",
      "twoFactorVerify",
      "contact",
      // Lobby display pairing start / admin code bind (#27, ADR-001 §5).
      // displayClaim is deliberately NOT auth-sensitive: the claim poll can
      // only present the code inside its own server-signed blob, so it has
      // no credential-guessing surface.
      "displayPairing",
      // AI help assistant (#2211, C3): the per-member/per-IP/global limiters
      // guard paid model spend, so a degraded shared-store fallback must not be
      // usable to multiply paid-call budget across replicas.
      "aiChatMember",
      "aiChatIp",
      "aiChatGlobal",
    ].sort();

    const marked = Object.entries(rateLimiters)
      .filter(([, config]) => (config as { authSensitive?: boolean }).authSensitive)
      .map(([name]) => name)
      .sort();

    expect(marked).toEqual(expected);
  });
});
