import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ingestSesSnsEmailFeedback } from "@/lib/email";
import {
  parseSnsWebhookEnvelope,
  verifySnsWebhookMessage,
} from "@/lib/ses-sns";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import { recordWebhookLog } from "@/lib/webhook-log";
import logger from "@/lib/logger";
import { reportWebhookError } from "@/lib/observability-bridge";
import {
  isWebhookBodyInvalidContentLengthError,
  isWebhookBodyTooLargeError,
  readBoundedWebhookText,
} from "@/lib/webhook-body";

export const runtime = "nodejs";
const SES_SNS_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

async function recordSesWebhookLog({
  eventType,
  eventId,
  status,
  startedAt,
  error,
}: {
  eventType: string;
  eventId: string;
  status: "success" | "failure";
  startedAt: number;
  error?: string;
}) {
  await recordWebhookLog({
    source: "ses-sns",
    eventType,
    eventId,
    status,
    durationMs: Date.now() - startedAt,
    error,
  });
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let eventId = "unknown";
  let eventType = "unknown";
  let claimedEvent = false;

  try {
    let payload: unknown;
    try {
      payload = JSON.parse(
        await readBoundedWebhookText(request, SES_SNS_WEBHOOK_MAX_BODY_BYTES)
      );
    } catch (error) {
      if (isWebhookBodyTooLargeError(error)) {
        await recordSesWebhookLog({
          eventType,
          eventId,
          status: "failure",
          startedAt,
          error: "Payload too large",
        });
        logger.warn(
          { maxBytes: SES_SNS_WEBHOOK_MAX_BODY_BYTES },
          "SES/SNS webhook payload exceeded size limit"
        );
        return NextResponse.json(
          { error: "Webhook payload too large" },
          { status: 413 }
        );
      }

      if (isWebhookBodyInvalidContentLengthError(error)) {
        await recordSesWebhookLog({
          eventType,
          eventId,
          status: "failure",
          startedAt,
          error: "Invalid content-length header",
        });
        logger.warn(
          { contentLength: error.contentLength },
          "SES/SNS webhook had invalid content-length header"
        );
        return NextResponse.json(
          { error: "Invalid content-length header" },
          { status: 400 }
        );
      }

      await recordSesWebhookLog({
        eventType,
        eventId,
        status: "failure",
        startedAt,
        error: "Invalid JSON",
      });
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const envelope = parseSnsWebhookEnvelope(payload);
    if (!envelope) {
      await recordSesWebhookLog({
        eventType,
        eventId,
        status: "failure",
        startedAt,
        error: "Invalid SNS envelope",
      });
      return NextResponse.json(
        { error: "Invalid SNS envelope" },
        { status: 400 }
      );
    }

    eventId = envelope.MessageId;
    eventType = envelope.Type;

    const verification = await verifySnsWebhookMessage(envelope);
    if (!verification.ok) {
      await recordSesWebhookLog({
        eventType,
        eventId,
        status: "failure",
        startedAt,
        error: verification.error,
      });
      return NextResponse.json(
        { error: "SNS signature verification failed" },
        { status: 401 }
      );
    }

    if (!verification.topicArnConfigured) {
      logger.warn(
        { snsTopicArn: envelope.TopicArn },
        "SES_SNS_TOPIC_ARN is not configured; SNS signature was verified without a topic allowlist"
      );
    }

    if (envelope.Type !== "Notification") {
      await recordSesWebhookLog({
        eventType,
        eventId,
        status: "success",
        startedAt,
      });
      return NextResponse.json({ received: true, type: envelope.Type });
    }

    try {
      await prisma.processedWebhookEvent.create({
        data: {
          eventId,
          source: "ses-sns",
          eventType,
        },
      });
      claimedEvent = true;
    } catch (err) {
      if (isPrismaUniqueConstraintError(err)) {
        return NextResponse.json({ received: true, duplicate: true });
      }
      throw err;
    }

    const result = await ingestSesSnsEmailFeedback(envelope);
    const feedbackEventType = result.handled
      ? `ses.${result.notificationType}`
      : "ses.unhandled";
    await recordSesWebhookLog({
      eventType: feedbackEventType,
      eventId,
      status: "success",
      startedAt,
    });

    return NextResponse.json({ received: true, ...result });
  } catch (err) {
    if (claimedEvent && eventId !== "unknown") {
      await prisma.processedWebhookEvent
        .deleteMany({ where: { eventId, source: "ses-sns" } })
        .catch((cleanupError) => {
          logger.error(
            { err: cleanupError, eventId },
            "Failed to release SES/SNS webhook claim after handler failure"
          );
        });
    }

    const message = err instanceof Error ? err.message : String(err);
    reportWebhookError({
      tag: "ses-sns",
      err,
      message: "Error processing SES/SNS webhook",
      context: { eventId, eventType },
    });
    await recordSesWebhookLog({
      eventType,
      eventId,
      status: "failure",
      startedAt,
      error: message,
    });

    return NextResponse.json(
      { error: "Failed to process SES/SNS webhook" },
      { status: 500 }
    );
  }
}
