import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { searchAddyAddresses } from "@/lib/addy-api";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { getFeatureFlagBlockResponse } from "../../proxy";

const mocks = vi.hoisted(() => ({
  emailVerificationFindUnique: vi.fn(),
  whakapapaReportCacheFindUnique: vi.fn(),
  fetchWhakapapaCurlData: vi.fn(),
  validateGuestChoreToken: vi.fn(),
  applyRateLimit: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailVerificationToken: {
      findUnique: mocks.emailVerificationFindUnique,
    },
    whakapapaReportCache: {
      findUnique: mocks.whakapapaReportCacheFindUnique,
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/whakapapa-report.server", () => ({
  fetchWhakapapaCurlData: mocks.fetchWhakapapaCurlData,
}));

vi.mock("@/lib/guest-chore-token", () => ({
  validateGuestChoreToken: mocks.validateGuestChoreToken,
}));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: mocks.applyRateLimit,
  rateLimiters: {
    addressAutocomplete: {
      id: "address-autocomplete",
      limit: 90,
      windowSeconds: 60,
    },
    guestChoreToken: {
      id: "guest-chore-token",
      limit: 20,
      windowSeconds: 15 * 60,
    },
    verificationToken: {
      id: "verification-token",
      limit: 10,
      windowSeconds: 15 * 60,
    },
    skifieldConditions: {
      id: "skifield-conditions",
      limit: 60,
      windowSeconds: 60,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("public endpoint abuse hardening", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("rejects malformed Addy detail sessions before proxying upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import(
      "@/app/api/address-autocomplete/details/[id]/route"
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/address-autocomplete/details/123?session=bad!"
      ),
      { params: Promise.resolve({ id: "123" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid address query",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks disabled address autocomplete routes before Addy lookup", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const flags = Object.fromEntries(
      MODULE_KEYS.map((key) => [key, true]),
    ) as FeatureFlags;

    const response = getFeatureFlagBlockResponse(
      "/api/address-autocomplete/search",
      { ...flags, addressAutocomplete: false },
    );

    expect(response?.status).toBe(404);
    await expect(response!.json()).resolves.toEqual({ error: "Not found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps Addy search suggestions even if the upstream response is larger", async () => {
    vi.stubEnv("ADDY_API_KEY", "test-key");
    vi.stubEnv("ADDY_API_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            addresses: Array.from({ length: 12 }, (_, index) => ({
              id: index + 1,
              a: `Address ${index + 1}`,
            })),
          }),
          { status: 200 }
        )
      )
    );

    const result = await searchAddyAddresses({ q: "main street" });

    expect(result.configured).toBe(true);
    expect(result.suggestions).toHaveLength(10);
    expect(result.suggestions.at(-1)).toEqual({
      id: "10",
      label: "Address 10",
    });
  });

  it("rejects malformed chore tokens before token lookup", async () => {
    const { GET } = await import("@/app/api/chores/[token]/route");

    const response = await GET(
      new NextRequest("http://localhost/api/chores/not-a-token"),
      { params: Promise.resolve({ token: "not-a-token" }) }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid or expired token",
    });
    expect(mocks.validateGuestChoreToken).not.toHaveBeenCalled();
  });

  it("rejects malformed verification tokens before database lookup", async () => {
    const { GET } = await import("@/app/api/auth/verify-email/route");

    const response = await GET(
      new NextRequest("http://localhost/api/auth/verify-email?token=not-a-token")
    );

    expect(response.status).toBe(307);
    const redirect = new URL(response.headers.get("location")!);
    expect(`${redirect.pathname}${redirect.search}`).toBe(
      "/login?verifyError=invalid"
    );
    expect(mocks.emailVerificationFindUnique).not.toHaveBeenCalled();
  });

  it("rejects malformed ski-condition widget hashes before proxying upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/skifield-conditions/route");

    const response = await GET(
      new NextRequest("http://localhost/api/skifield-conditions?hash=bad")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      _error: "A valid 32-character widget hash is required.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves cached Whakapapa conditions as a public website payload", async () => {
    const fetchedAt = new Date();
    mocks.whakapapaReportCacheFindUnique.mockResolvedValue({
      source: "whakapapa-report",
      payload: {
        updated: "2026-06-22T00:00:00.000Z",
        roadStatus: {
          name: "Bruce Road",
          status: "Open",
          wheelRequirements: "",
          roadContent: "",
        },
        chairlifts: [],
        conditions: [],
      },
      fetchedAt,
      frozenUntil: null,
    });

    const { GET } = await import("@/app/api/skifield-whakapapa/route");
    const response = await GET(
      new NextRequest("http://localhost/api/skifield-whakapapa")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("public");
    await expect(response.json()).resolves.toMatchObject({
      roadStatus: { name: "Bruce Road", status: "Open" },
    });
    expect(mocks.applyRateLimit).toHaveBeenCalled();
    expect(mocks.fetchWhakapapaCurlData).not.toHaveBeenCalled();
  });

  it("does not expose upstream Whakapapa failure details", async () => {
    mocks.whakapapaReportCacheFindUnique.mockResolvedValue(null);
    mocks.fetchWhakapapaCurlData.mockRejectedValue(
      new Error("upstream request included private proxy token secret-proxy-token")
    );

    const { GET } = await import("@/app/api/skifield-whakapapa/route");
    const response = await GET(
      new NextRequest("http://localhost/api/skifield-whakapapa")
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "Unable to fetch Whakapapa report data.",
    });
  });
});
