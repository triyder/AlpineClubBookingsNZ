import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getXeroConnectedOrganisation,
  resetXeroOrganisationCachesForTests,
} from "@/lib/xero-organisation";
import { invalidateXeroOrganisationCaches } from "@/lib/xero-organisation-cache-bus";

// CORRECTNESS-F1: the connected-org summary is cached in-process for hours. A
// disconnect → reconnect to a DIFFERENT org must not keep serving the OLD org's
// name (the exact mistake the wizard's right-org step exists to catch). The
// token store invalidates the cache via the bus; these pins prove the cache is
// honoured AND that invalidation forces a fresh read of the new org.
describe("xero-organisation cache invalidation (#2080 F1)", () => {
  const originalOrigin = process.env.XERO_MOCK_API_ORIGIN;

  function mockOrg(name: string) {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ name, financialYearEndMonth: 3 }),
    })) as unknown as typeof fetch;
  }

  beforeEach(() => {
    // Drive the mock-Xero organisation path (no live Xero / DB), non-production.
    vi.stubEnv("NODE_ENV", "test");
    process.env.XERO_MOCK_API_ORIGIN = "http://localhost:3000";
    resetXeroOrganisationCachesForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetXeroOrganisationCachesForTests();
    if (originalOrigin === undefined) delete process.env.XERO_MOCK_API_ORIGIN;
    else process.env.XERO_MOCK_API_ORIGIN = originalOrigin;
  });

  it("serves the cached org name until the cache is invalidated", async () => {
    mockOrg("Org A");
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");

    // The org changed underneath, but without invalidation the cache still wins.
    mockOrg("Org B");
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");
  });

  it("returns the NEW org name after a reconnect invalidates the cache", async () => {
    mockOrg("Org A");
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");

    // Simulate the token store's reconnect-to-different-org invalidation.
    mockOrg("Org B");
    invalidateXeroOrganisationCaches();

    expect((await getXeroConnectedOrganisation()).name).toBe("Org B");
  });

  it("forceRefresh also bypasses the cache (belt-and-braces / ?refresh=1)", async () => {
    mockOrg("Org A");
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");

    mockOrg("Org B");
    expect((await getXeroConnectedOrganisation(true)).name).toBe("Org B");
  });
});
