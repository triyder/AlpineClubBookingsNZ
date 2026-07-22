import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetPublishable } = vi.hoisted(() => ({
  mockGetPublishable: vi.fn(),
}));

vi.mock("@/lib/stripe-config", () => ({
  getOperationalStripePublishableKey: (...a: unknown[]) =>
    mockGetPublishable(...a),
}));

import { GET } from "@/app/api/stripe/publishable-key/route";

describe("GET /api/stripe/publishable-key (#2082 runtime delivery)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the stored publishable key at runtime", async () => {
    mockGetPublishable.mockResolvedValue("pk_test_abc");
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ publishableKey: "pk_test_abc" });
  });

  it("returns null (not an error) when unconfigured", async () => {
    mockGetPublishable.mockResolvedValue(undefined);
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ publishableKey: null });
  });

  it("fails soft to null when the resolver throws", async () => {
    mockGetPublishable.mockRejectedValue(new Error("db down"));
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ publishableKey: null });
  });
});
