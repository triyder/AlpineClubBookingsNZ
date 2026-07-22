import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockGetPublicHealthReport, mockConstructWebhookEvent } = vi.hoisted(() => ({
  mockGetPublicHealthReport: vi.fn(),
  mockConstructWebhookEvent: vi.fn(),
}));

vi.mock("@/lib/health-check", () => ({
  getPublicHealthReport: mockGetPublicHealthReport,
}));

vi.mock("@/lib/stripe", () => ({
  constructWebhookEvent: mockConstructWebhookEvent,
}));

// DB-only (#2082): the webhook route resolves its signing secret from the C1
// store via stripe-config, not the environment. Provide the secret so the route
// reaches the signature check under test.
vi.mock("@/lib/stripe-config", () => ({
  getOperationalStripeWebhookSecret: vi.fn().mockResolvedValue("whsec_test"),
  recordStripeWebhookVerified: vi.fn(),
}));

vi.mock("@/lib/stripe-webhook-service", () => ({
  processStripeWebhookEvent: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { GET as getHealth } from "@/app/api/health/route";
import { POST as postStripeWebhook } from "@/app/api/webhooks/stripe/route";

describe("public and webhook route boundary behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPublicHealthReport.mockResolvedValue({
      httpStatus: 200,
      report: {
        status: "healthy",
        version: "0.5.0",
        uptime: 12,
        checks: { db: { status: "ok", latencyMs: 1 } },
      },
    });
  });

  it("keeps the public health route session-free and redacted", async () => {
    const response = await getHealth();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "healthy",
      version: "0.5.0",
      uptime: 12,
      checks: { db: { status: "ok", latencyMs: 1 } },
    });
  });

  it("keeps Stripe webhooks signature-gated instead of session-gated", async () => {
    const response = await postStripeWebhook(
      new NextRequest("https://example.test/api/webhooks/stripe", {
        method: "POST",
        body: JSON.stringify({ id: "evt_1" }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing stripe-signature header",
    });
    expect(mockConstructWebhookEvent).not.toHaveBeenCalled();
  });
});
