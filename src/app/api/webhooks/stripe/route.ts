import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import logger from "@/lib/logger";
import { constructWebhookEvent } from "@/lib/stripe";
import {
  getOperationalStripeWebhookSecret,
  recordStripeWebhookVerified,
} from "@/lib/stripe-config";
import { processStripeWebhookEvent } from "@/lib/stripe-webhook-service";
import {
  isWebhookBodyInvalidContentLengthError,
  isWebhookBodyTooLargeError,
  readBoundedWebhookText,
} from "@/lib/webhook-body";

const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Stripe webhook handler.
 * Handles payment_intent and setup_intent lifecycle events.
 *
 * IMPORTANT: Always verify webhook signature before processing.
 */
export async function POST(request: NextRequest) {
  // DB-only, FAIL-CLOSED (#2082): the signing secret comes from the dedicated
  // C1-style resolver. No secret (or a resolver error) ⇒ reject; never accept.
  let webhookSecret: string | undefined;
  try {
    webhookSecret = await getOperationalStripeWebhookSecret();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.name : "unknown" },
      "Stripe webhook secret resolver failed"
    );
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }
  if (!webhookSecret) {
    logger.error("Stripe webhook signing secret is not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    const body = await readBoundedWebhookText(
      request,
      STRIPE_WEBHOOK_MAX_BODY_BYTES
    );
    event = await constructWebhookEvent(body, signature, webhookSecret);
  } catch (err) {
    if (isWebhookBodyTooLargeError(err)) {
      logger.warn(
        { maxBytes: STRIPE_WEBHOOK_MAX_BODY_BYTES },
        "Stripe webhook payload exceeded size limit"
      );
      return NextResponse.json(
        { error: "Webhook payload too large" },
        { status: 413 }
      );
    }

    if (isWebhookBodyInvalidContentLengthError(err)) {
      logger.warn(
        { contentLength: err.contentLength },
        "Stripe webhook had invalid content-length header"
      );
      return NextResponse.json(
        { error: "Invalid content-length header" },
        { status: 400 }
      );
    }

    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err: message }, "Webhook signature verification failed");
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 }
    );
  }

  // Freshness-scoped webhook-verified marker (#2082): a signature-verified
  // TEST-MODE event proves the wizard's endpoint + signing secret are wired
  // through the exact production resolver/HMAC path. Only test-mode events set
  // it (live traffic never marks setup "verified"); it is best-effort and never
  // affects the webhook response, and verify-reset drops it on any credential
  // change so a green badge cannot survive a signing-secret swap.
  if (event.livemode === false) {
    await recordStripeWebhookVerified();
  }

  const result = await processStripeWebhookEvent(event);
  return NextResponse.json(result.body, result.init);
}
