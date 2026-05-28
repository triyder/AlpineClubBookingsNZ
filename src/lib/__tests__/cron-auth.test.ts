import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isValidCronSecret, requireCronSecret } from "@/lib/cron-auth";

function requestWithSecret(secret?: string) {
  return new NextRequest("https://example.test/api/cron", {
    headers: secret ? { "x-cron-secret": secret } : undefined,
  });
}

describe("cron auth helpers", () => {
  it("accepts matching secrets", () => {
    expect(isValidCronSecret("cron-secret", "cron-secret")).toBe(true);
  });

  it("rejects missing, wrong, and different-length secrets", () => {
    expect(isValidCronSecret(null, "cron-secret")).toBe(false);
    expect(isValidCronSecret("wrong-secret", "cron-secret")).toBe(false);
    expect(isValidCronSecret("short", "cron-secret")).toBe(false);
  });

  it("returns the shared unauthorised response for cron routes", async () => {
    process.env.CRON_SECRET = "cron-secret";

    const response = requireCronSecret(requestWithSecret("wrong-secret"));

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toEqual({
      error: "Unauthorised",
    });
  });

  it("allows legacy deploy routes to preserve their response spelling", async () => {
    process.env.CRON_SECRET = "cron-secret";

    const response = requireCronSecret(requestWithSecret(), {
      errorMessage: "Unauthorized",
    });

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toEqual({
      error: "Unauthorized",
    });
  });
});
