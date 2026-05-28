import { after, NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { recordWebhookLog } from "@/lib/webhook-log";
import logger from "@/lib/logger";
import { buildXeroIdempotencyKey, recordXeroInboundEvent } from "@/lib/xero-sync";
import { runXeroInboundReconciliationCycle } from "@/lib/xero-inbound-reconciliation";
import { isXeroConnected } from "@/lib/xero";
import {
  isWebhookBodyTooLargeError,
  readBoundedWebhookText,
} from "@/lib/webhook-body";

const XERO_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const XERO_WEBHOOK_MAX_EVENTS = 100;

type XeroWebhookEventPayload = {
  eventType?: string;
  eventCategory?: string;
  resourceId?: string;
  eventDateUtc?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isXeroWebhookEventPayload(
  value: unknown
): value is XeroWebhookEventPayload {
  return (
    isRecord(value) &&
    isOptionalString(value.eventType) &&
    isOptionalString(value.eventCategory) &&
    isOptionalString(value.resourceId) &&
    isOptionalString(value.eventDateUtc)
  );
}

function scheduleAfterResponse(task: () => Promise<void>) {
  try {
    after(task);
  } catch {
    queueMicrotask(() => {
      void task();
    });
  }
}

/**
 * POST /api/webhooks/xero
 * Handles Xero webhook events.
 *
 * Xero webhooks use an intent-to-receive pattern:
 * 1. First, Xero sends a validation request with a payload
 * 2. We must respond with the correct HMAC-SHA256 hash
 * 3. Then Xero starts sending actual event payloads
 */
export async function POST(request: NextRequest) {
  const webhookKey = process.env.XERO_WEBHOOK_KEY;
  if (!webhookKey) {
    return NextResponse.json(
      { error: "Xero webhook key not configured" },
      { status: 500 }
    );
  }

  const signature = request.headers.get("x-xero-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  let body: string;
  try {
    body = await readBoundedWebhookText(request, XERO_WEBHOOK_MAX_BODY_BYTES);
  } catch (error) {
    if (isWebhookBodyTooLargeError(error)) {
      logger.warn(
        { maxBytes: XERO_WEBHOOK_MAX_BODY_BYTES },
        "Xero webhook payload exceeded size limit"
      );
      return NextResponse.json(
        { error: "Webhook payload too large" },
        { status: 413 }
      );
    }
    throw error;
  }

  // Verify HMAC-SHA256 signature
  const expectedSignature = createHmac("sha256", webhookKey)
    .update(body)
    .digest("base64");

  // timingSafeEqual requires equal-length buffers; reject mismatches as invalid
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    // Xero requires a 401 response for invalid signatures
    return new NextResponse(null, { status: 401 });
  }

  // Parse the payload
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Handle events
  if (!isRecord(payload)) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const events = payload.events ?? [];
  if (!Array.isArray(events)) {
    return NextResponse.json({ error: "Invalid events payload" }, { status: 400 });
  }

  if (events.length > XERO_WEBHOOK_MAX_EVENTS) {
    return NextResponse.json(
      { error: "Too many webhook events" },
      { status: 413 }
    );
  }

  for (const event of events) {
    if (!isXeroWebhookEventPayload(event)) {
      return NextResponse.json(
        { error: "Invalid webhook event payload" },
        { status: 400 }
      );
    }

    const { eventType, eventCategory, resourceId } = event;
    const eventStart = Date.now();
    const eventDateUtc =
      typeof event.eventDateUtc === "string" ? new Date(event.eventDateUtc) : null;
    const correlationKey = buildXeroIdempotencyKey(
      "xero",
      "webhook",
      eventCategory || "UNKNOWN",
      eventType || "UNKNOWN",
      resourceId || "UNKNOWN",
      typeof event.eventDateUtc === "string" ? event.eventDateUtc : "NO_DATE"
    );

    try {
      await recordXeroInboundEvent({
        source: "webhook",
        eventCategory: eventCategory ?? null,
        eventType: eventType ?? "UNKNOWN",
        resourceId: resourceId ?? null,
        eventCreatedAt: eventDateUtc,
        correlationKey,
        payload: event,
        status: "RECEIVED",
      });

      // Log for now - specific handlers can be added as needed
      logger.info({ eventCategory, eventType, resourceId }, "Xero webhook event received");

      // Handle contact updates (membership changes)
      if (eventCategory === "CONTACT" && eventType === "UPDATE") {
        // Could trigger membership re-check here
        logger.info({ resourceId }, "Xero contact updated");
      }

      // Handle invoice status changes
      if (eventCategory === "INVOICE") {
        logger.info({ eventType, resourceId }, "Xero invoice event");
      }

      // OBS-08: Record successful webhook processing
      await recordWebhookLog({
        source: "xero",
        eventType: `${eventCategory}.${eventType}`,
        eventId: resourceId || "unknown",
        status: "success",
        durationMs: Date.now() - eventStart,
      });
    } catch (err) {
      await recordXeroInboundEvent({
        source: "webhook",
        eventCategory: eventCategory ?? null,
        eventType: eventType ?? "UNKNOWN",
        resourceId: resourceId ?? null,
        eventCreatedAt: eventDateUtc,
        correlationKey,
        payload: event,
        status: "FAILED",
        errorMessage: err instanceof Error ? err.message : String(err),
      });

      logger.error({ err, eventCategory, eventType, resourceId }, "Error processing Xero webhook event");

      // OBS-08: Record failed webhook processing
      await recordWebhookLog({
        source: "xero",
        eventType: `${eventCategory}.${eventType}`,
        eventId: resourceId || "unknown",
        status: "failure",
        durationMs: Date.now() - eventStart,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (events.length > 0) {
    scheduleAfterResponse(async () => {
      try {
        if (!(await isXeroConnected())) {
          return;
        }

        await runXeroInboundReconciliationCycle({
          batchSize: Math.min(Math.max(events.length, 1), 10),
          maxBatches: 3,
        });
      } catch (error) {
        logger.error({ err: error }, "Failed to kick Xero inbound reconciliation worker");
      }
    });
  }

  // Xero expects a 200 response
  return NextResponse.json({ status: "ok" });
}
