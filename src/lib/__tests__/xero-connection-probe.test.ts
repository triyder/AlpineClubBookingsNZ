import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getAuthenticatedXeroClient: vi.fn(),
  getXeroLockDates: vi.fn(),
  getLatestXeroUsageErrorMessage: vi.fn(),
}));

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: h.getAuthenticatedXeroClient,
}));
vi.mock("@/lib/xero-organisation", () => ({
  getXeroLockDates: h.getXeroLockDates,
}));
vi.mock("@/lib/xero-api-usage", () => ({
  getLatestXeroUsageErrorMessage: h.getLatestXeroUsageErrorMessage,
}));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
// redact-sensitive-json is intentionally NOT mocked so redaction is exercised.

import {
  probeXeroConnectionHealth,
  resetXeroConnectionProbeCacheForTests,
} from "@/lib/xero-connection-probe";

const named = (name: string) => Object.assign(new Error(name), { name });

beforeEach(() => {
  vi.clearAllMocks();
  resetXeroConnectionProbeCacheForTests();
  h.getAuthenticatedXeroClient.mockResolvedValue({ xero: {}, tenantId: "t" });
  h.getXeroLockDates.mockResolvedValue({ periodLockDate: null, endOfYearLockDate: null });
  h.getLatestXeroUsageErrorMessage.mockResolvedValue(null);
});

describe("probeXeroConnectionHealth (#2105)", () => {
  it("reports ok and reuses the cached lock-date read (false) when healthy", async () => {
    const result = await probeXeroConnectionHealth(1000);

    expect(result.tokenHealth).toBe("ok");
    expect(result.cached).toBe(false);
    expect(result.lastErrorMessage).toBeNull();
    expect(h.getXeroLockDates).toHaveBeenCalledWith(false);
  });

  it("serves a cached result inside the window and refetches past it", async () => {
    const first = await probeXeroConnectionHealth(1000);
    expect(first.cached).toBe(false);

    const cached = await probeXeroConnectionHealth(1000 + 30_000);
    expect(cached.cached).toBe(true);
    expect(h.getAuthenticatedXeroClient).toHaveBeenCalledTimes(1);

    const refetched = await probeXeroConnectionHealth(1000 + 46_000);
    expect(refetched.cached).toBe(false);
    expect(h.getAuthenticatedXeroClient).toHaveBeenCalledTimes(2);
  });

  it("maps a daily-limit cooldown to rate_limited WITHOUT any Xero API call", async () => {
    h.getAuthenticatedXeroClient.mockRejectedValue(named("XeroDailyLimitError"));

    const result = await probeXeroConnectionHealth(1000);

    expect(result.tokenHealth).toBe("rate_limited");
    // The in-process gate throws before the network call, so the org read never runs.
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("maps a reconnect-required failure and surfaces the redacted last usage error", async () => {
    h.getAuthenticatedXeroClient.mockRejectedValue(named("XeroReconnectRequiredError"));
    h.getLatestXeroUsageErrorMessage.mockResolvedValue(
      "token refresh failed for admin@example.com",
    );

    const result = await probeXeroConnectionHealth(1000);

    expect(result.tokenHealth).toBe("reconnect_required");
    // The email in the recorded error must not reach the client verbatim.
    expect(result.lastErrorMessage).toBe("[REDACTED]");
    expect(result.lastErrorMessage).not.toContain("admin@example.com");
  });

  it("maps an undecryptable stored token (XeroTokenDecryptError) to reconnect_required", async () => {
    // #2079: loadXeroTokens now throws XeroTokenDecryptError when a stored token
    // no longer decrypts; the probe must classify it as reconnect, not error.
    h.getAuthenticatedXeroClient.mockRejectedValue(named("XeroTokenDecryptError"));

    const result = await probeXeroConnectionHealth(1000);

    expect(result.tokenHealth).toBe("reconnect_required");
  });

  it("maps an unclassified failure to error", async () => {
    h.getAuthenticatedXeroClient.mockRejectedValue(new Error("boom"));

    const result = await probeXeroConnectionHealth(1000);

    expect(result.tokenHealth).toBe("error");
  });

  it("maps a raw 401/403 live-read failure to reconnect_required (revoked-token window)", async () => {
    h.getAuthenticatedXeroClient.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), {
        response: { statusCode: 401 },
      }),
    );

    const result = await probeXeroConnectionHealth(1000);

    expect(result.tokenHealth).toBe("reconnect_required");
  });
});
