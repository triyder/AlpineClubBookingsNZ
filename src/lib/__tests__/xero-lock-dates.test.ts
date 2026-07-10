import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the Xero client infrastructure is stubbed; the parsing, caching, and
// max() logic under test are exercised for real (#1695).
const h = vi.hoisted(() => ({
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  getOrganisations: vi.fn(),
}));

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: h.getAuthenticatedXeroClient,
  callXeroApi: (fn: () => unknown) => h.callXeroApi(fn),
}));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  getEffectiveXeroLockDate,
  getXeroLockDates,
  resetXeroLockDatesCacheForTests,
} from "@/lib/xero-organisation";

function stubOrganisation(org: Record<string, unknown> | undefined) {
  h.getAuthenticatedXeroClient.mockResolvedValue({
    xero: { accountingApi: { getOrganisations: h.getOrganisations } },
    tenantId: "tenant-1",
  });
  h.callXeroApi.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  h.getOrganisations.mockResolvedValue({
    body: { organisations: org ? [org] : [] },
  });
}

const iso = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  resetXeroLockDatesCacheForTests();
});
afterEach(() => {
  resetXeroLockDatesCacheForTests();
});

describe("getXeroLockDates (#1695)", () => {
  it("parses ISO lock dates to date-only Dates", async () => {
    stubOrganisation({
      periodLockDate: "2026-03-31",
      endOfYearLockDate: "2025-12-31",
    });

    const result = await getXeroLockDates();
    expect(iso(result.periodLockDate)).toBe("2026-03-31");
    expect(iso(result.endOfYearLockDate)).toBe("2025-12-31");
  });

  it("parses Microsoft-JSON /Date(...)/ lock dates", async () => {
    const epochMs = Date.UTC(2026, 2, 31); // 2026-03-31
    stubOrganisation({ periodLockDate: `/Date(${epochMs}+1300)/` });

    const result = await getXeroLockDates();
    expect(iso(result.periodLockDate)).toBe("2026-03-31");
    expect(result.endOfYearLockDate).toBeNull();
  });

  it("returns null for both when unset or no organisation is present", async () => {
    stubOrganisation(undefined);
    await expect(getXeroLockDates()).resolves.toEqual({
      periodLockDate: null,
      endOfYearLockDate: null,
    });

    resetXeroLockDatesCacheForTests();
    stubOrganisation({ periodLockDate: null, endOfYearLockDate: undefined });
    await expect(getXeroLockDates()).resolves.toEqual({
      periodLockDate: null,
      endOfYearLockDate: null,
    });
  });

  it("getEffectiveXeroLockDate returns the later of the two set dates", () => {
    expect(
      iso(
        getEffectiveXeroLockDate({
          periodLockDate: new Date("2026-03-31T00:00:00.000Z"),
          endOfYearLockDate: new Date("2025-12-31T00:00:00.000Z"),
        }),
      ),
    ).toBe("2026-03-31");

    expect(
      iso(
        getEffectiveXeroLockDate({
          periodLockDate: null,
          endOfYearLockDate: new Date("2025-12-31T00:00:00.000Z"),
        }),
      ),
    ).toBe("2025-12-31");

    expect(
      getEffectiveXeroLockDate({ periodLockDate: null, endOfYearLockDate: null }),
    ).toBeNull();
  });

  it("caches within the 5-minute TTL (second call does not refetch)", async () => {
    stubOrganisation({ periodLockDate: "2026-03-31" });

    await getXeroLockDates();
    await getXeroLockDates();

    expect(h.getOrganisations).toHaveBeenCalledTimes(1);
  });

  it("throws on fetch failure with no fresh cache (fails closed)", async () => {
    h.getAuthenticatedXeroClient.mockRejectedValue(new Error("xero unavailable"));
    await expect(getXeroLockDates()).rejects.toThrow("xero unavailable");
  });
});
