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

  it("rejects a correctly signed non-JSON body without recording events", async () => {
    // Malformed row of the webhook Critical matrix (issue #1133): the HMAC is
    // valid for the raw bytes but the body is not JSON. Signature verification
    // runs first (over raw bytes), then parsing fails closed.
    const { POST } = await import("@/app/api/webhooks/xero/route");
    const body = "not-json{";
    const signature = createHmac("sha256", "xero-webhook-key")
      .update(body)
      .digest("base64");

    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/xero", {
        method: "POST",
        headers: { "x-xero-signature": signature },
        body,
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON" });
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("maps a replayed event to the same idempotency correlation key", async () => {
    // Duplicate row of the webhook Critical matrix (issue #1133): DB-level
    // dedup lives in recordXeroInboundEvent (unique correlationKey with
    // terminal-state preservation — covered in xero-sync.test.ts). The route
    // contract frozen here is that an identical redelivery produces the
    // identical correlation key, so a replay converges on the same row even
    // across process restarts.
    const { POST } = await import("@/app/api/webhooks/xero/route");
    const payload = {
      events: [
        {
          eventType: "UPDATE",
          eventCategory: "INVOICE",
          resourceId: "inv-123",
          eventDateUtc: "2026-07-01T00:00:00.000Z",
        },
      ],
    };

    const first = await POST(signedRequest(payload));
    const second = await POST(signedRequest(payload));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockRecordXeroInboundEvent).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mockRecordXeroInboundEvent.mock.calls;
    expect(firstCall[0].correlationKey).toBeTruthy();
    expect(secondCall[0].correlationKey).toBe(firstCall[0].correlationKey);
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

  it("rejects malformed Xero webhook content-length before signature verification", async () => {
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
          "content-length": "256kb",
        },
        body,
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid content-length header",
    });
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("rejects signed Xero events with invalid event dates", async () => {
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(
      signedRequest({
        events: [
          {
            eventType: "UPDATE",
            eventCategory: "INVOICE",
            resourceId: "invoice-1",
            eventDateUtc: "not-a-date",
          },
        ],
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid webhook event payload",
    });
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("records valid signed Xero events with required resource identity", async () => {
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(
      signedRequest({
        events: [
          {
            eventType: "UPDATE",
            eventCategory: "INVOICE",
            resourceId: "invoice-1",
            eventDateUtc: "2026-05-29T00:00:00.000Z",
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(mockRecordXeroInboundEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "invoice-1",
        eventCreatedAt: new Date("2026-05-29T00:00:00.000Z"),
        correlationKey:
          "xero:webhook:INVOICE:UPDATE:invoice-1:2026-05-29T00:00:00.000Z",
      })
    );
  });
});
