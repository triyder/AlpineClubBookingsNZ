import { describe, it, expect, vi } from "vitest";
import Stripe from "stripe";

// #4029: every other webhook test mocks the SDK, so none of them would notice a
// stripe-node major changing what the tolerance argument means (23.0.0 did that
// to `verifyHeader`). This suite runs the REAL SDK's verification through our
// `constructWebhookEvent`: only the secret-key resolver is mocked, and nothing
// here touches the network (verification is local HMAC).
vi.mock("@/lib/stripe-config", () => ({
  getOperationalStripeSecretKey: vi.fn().mockResolvedValue("sk_test_fake"),
}));

const { constructWebhookEvent, STRIPE_WEBHOOK_TOLERANCE_SECONDS } = await import(
  "../stripe"
);

const secret = "whsec_real_sdk_test";
const payload = JSON.stringify({
  id: "evt_real_sdk",
  object: "event",
  type: "payment_intent.succeeded",
  data: { object: { id: "pi_real_sdk", object: "payment_intent" } },
});

function header(timestamp: number, signingSecret = secret): string {
  return Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: signingSecret,
    timestamp,
  });
}

// The SDK reads the same `Date.now()` the suite does (frozen under the test
// clock), so these offsets are measured on one clock and cannot drift.
const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("constructWebhookEvent with the real Stripe SDK (#4029)", () => {
  it("accepts a freshly signed event", async () => {
    const event = await constructWebhookEvent(payload, header(nowSeconds()), secret);
    expect(event.id).toBe("evt_real_sdk");
  });

  it("refuses a signature older than the tolerance as a possible replay", async () => {
    const stale = nowSeconds() - STRIPE_WEBHOOK_TOLERANCE_SECONDS - 60;
    await expect(
      constructWebhookEvent(payload, header(stale), secret)
    ).rejects.toThrow(/tolerance/i);
  });

  it("accepts a signature comfortably inside the tolerance", async () => {
    const recent = nowSeconds() - Math.floor(STRIPE_WEBHOOK_TOLERANCE_SECONDS / 2);
    const event = await constructWebhookEvent(payload, header(recent), secret);
    expect(event.id).toBe("evt_real_sdk");
  });

  it("refuses a signature made with a different secret", async () => {
    await expect(
      constructWebhookEvent(payload, header(nowSeconds(), "whsec_other"), secret)
    ).rejects.toThrow(/No signatures found/);
  });

  it("keeps the tolerance positive, because 0 would skip the timestamp check", () => {
    expect(STRIPE_WEBHOOK_TOLERANCE_SECONDS).toBeGreaterThan(0);
  });
});
