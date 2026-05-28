import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockRecordWebhookLog,
  mockRecordXeroInboundEvent,
  mockRunXeroInboundReconciliationCycle,
  mockIsXeroConnected,
} = vi.hoisted(() => ({
  mockRecordWebhookLog: vi.fn().mockResolvedValue(undefined),
  mockRecordXeroInboundEvent: vi.fn().mockResolvedValue(undefined),
  mockRunXeroInboundReconciliationCycle: vi.fn().mockResolvedValue(undefined),
  mockIsXeroConnected: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/webhook-log", () => ({
  recordWebhookLog: (...args: unknown[]) => mockRecordWebhookLog(...args),
}));

vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  recordXeroInboundEvent: (...args: unknown[]) =>
    mockRecordXeroInboundEvent(...args),
}));

vi.mock("@/lib/xero-inbound-reconciliation", () => ({
  runXeroInboundReconciliationCycle: (...args: unknown[]) =>
    mockRunXeroInboundReconciliationCycle(...args),
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: (...args: unknown[]) => mockIsXeroConnected(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function signedRequest(payload: unknown, signatureOverride?: string) {
  const body = JSON.stringify(payload);
  const signature =
    signatureOverride ??
    createHmac("sha256", "xero-webhook-key").update(body).digest("base64");

  return new NextRequest("http://localhost/api/webhooks/xero", {
    method: "POST",
    headers: {
      "x-xero-signature": signature,
    },
    body,
  });
}

describe("Xero webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("XERO_WEBHOOK_KEY", "xero-webhook-key");
  });

  it("rejects invalid signatures before parsing the payload", async () => {
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(signedRequest({ events: [] }, "bad-signature"));

    expect(response.status).toBe(401);
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("accepts a valid signed payload", async () => {
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(signedRequest({ events: [] }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("rejects malformed events payloads after signature verification", async () => {
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(signedRequest({ events: {} }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid events payload",
    });
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("rejects oversized Xero webhook payloads before signature verification", async () => {
    const body = "{}";
    const signature = createHmac("sha256", "xero-webhook-key")
      .update(body)
      .digest("base64");
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/xero", {
        method: "POST",
        headers: {
          "x-xero-signature": signature,
          "content-length": String(256 * 1024 + 1),
        },
        body,
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Webhook payload too large",
    });
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });
});
