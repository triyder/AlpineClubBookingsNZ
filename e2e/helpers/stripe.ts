import { expect, type FrameLocator, type Page } from "@playwright/test";

// The Stripe payment specs need a genuine test-mode account: the Payment
// Element loads from js.stripe.com and rejects placeholder keys. Specs skip
// unless both keys look like real test-mode keys, and the suite refuses to run
// against live keys outright.
export function stripeTestModeConfigured(): boolean {
  const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";

  if (secretKey.startsWith("sk_live") || publishableKey.startsWith("pk_live")) {
    throw new Error(
      "Live Stripe keys detected in the E2E environment. The E2E suite must " +
        "only ever run against Stripe test mode.",
    );
  }

  const looksReal = (key: string, prefix: string) =>
    key.startsWith(prefix) &&
    !key.toLowerCase().includes("placeholder") &&
    !key.toLowerCase().includes("fake") &&
    key.length > 30;

  return (
    looksReal(secretKey, "sk_test_") && looksReal(publishableKey, "pk_test_")
  );
}

export const STRIPE_SKIP_REASON =
  "Stripe test-mode keys not configured. Set STRIPE_SECRET_KEY (sk_test_…) and " +
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (pk_test_…) in the staging env file and " +
  "rebuild the app image to enable the payment specs (docs/E2E_PLAYWRIGHT.md).";

// Standard Stripe test cards: https://docs.stripe.com/testing
export const TEST_CARDS = {
  success: "4242424242424242",
  declined: "4000000000000002",
};

// Current Stripe.js mounts more than one iframe with this title (an
// accessory frame plus the card "easel"), so a bare title locator trips
// strict mode. Probe the matching frames for the one actually hosting the
// card inputs instead of relying on Stripe's internal frame layout.
async function paymentElementFrame(page: Page): Promise<FrameLocator> {
  const candidates = page.locator('iframe[title="Secure payment input frame"]');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const count = await candidates.count();
    for (let i = 0; i < count; i++) {
      const frame = page.frameLocator(
        `iframe[title="Secure payment input frame"] >> nth=${i}`,
      );
      const visible = await frame
        .getByPlaceholder("1234 1234 1234 1234")
        .isVisible()
        .catch(() => false);
      if (visible) return frame;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    "Stripe Payment Element card frame did not appear within 30s",
  );
}

// Fills the Payment Element card form and submits the wizard's Pay button.
export async function payWithCard(page: Page, cardNumber: string): Promise<void> {
  const frame = await paymentElementFrame(page);
  const cardField = frame.getByPlaceholder("1234 1234 1234 1234");
  await expect(cardField).toBeVisible({ timeout: 30_000 });
  await cardField.fill(cardNumber);
  await frame.getByPlaceholder("MM / YY").fill("12/34");
  await frame.getByPlaceholder("CVC").fill("123");

  const postcode = frame.getByPlaceholder(/postal code|postcode/i);
  if (await postcode.isVisible().catch(() => false)) {
    await postcode.fill("3420");
  }

  await page.getByRole("button", { name: "Pay Now" }).click();
}
