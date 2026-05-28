import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import logger from "@/lib/logger";
import { constructWebhookEvent } from "@/lib/stripe";
import { processStripeWebhookEvent } from "@/lib/stripe-webhook-service";
import {
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
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error("STRIPE_WEBHOOK_SECRET is not set");
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
    event = constructWebhookEvent(body, signature, webhookSecret);
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

    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err: message }, "Webhook signature verification failed");
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 }
    );
  }

  const result = await processStripeWebhookEvent(event);
  return NextResponse.json(result.body, result.init);
}
