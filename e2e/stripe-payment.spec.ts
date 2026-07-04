import { expect, test } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import {
  bookSelfToReviewStep,
  confirmBookingToPaymentStep,
  fetchOccupiedBeds,
} from "./helpers/booking";
import { personas } from "./helpers/personas";
import { stayWindow } from "./helpers/stay-dates";
import {
  payWithCard,
  STRIPE_SKIP_REASON,
  stripeTestModeConfigured,
  TEST_CARDS,
} from "./helpers/stripe";

// Critical row: Stripe test-mode payment success and failure through the
// booking wizard's in-wizard card step. Requires a genuine Stripe test-mode
// account — the specs skip loudly when only placeholder keys are configured
// and refuse to run at all against live keys (stripeTestModeConfigured throws).
const configured = stripeTestModeConfigured();

test.use({ storageState: storageStatePath(personas.booker.email) });

test.skip(!configured, STRIPE_SKIP_REASON);

// Retry these specs, overriding the suite's deterministic retries: 0. The app's
// payment handling is correct (verified end-to-end), but the US-geography CI
// runners intermittently trip Stripe's datacenter-IP defenses: an invisible
// hCaptcha / Radar challenge and the Link "universal-link-modal" occasionally
// intercept confirmPayment before the card is submitted, so no charge — and thus
// no success banner or decline copy — ever occurs within the wait (issue #1224,
// diagnosed from the CI network trace: Link modal + hcaptcha frames, no
// /confirm request, no card_declined). A fresh browser context per retry clears
// Stripe's Link cookies and usually recovers; the constant datacenter IP means
// Radar can still re-challenge, so retries reduce — not eliminate — the flake.
// The e2e job is non-blocking by design, which tolerates the residual.
test.describe.configure({ retries: 2 });

test("test-mode card payment succeeds and confirms the booking", async ({
  page,
}) => {
  const window = stayWindow(1);
  const occupiedBefore = await fetchOccupiedBeds(page, window.nights);
  await bookSelfToReviewStep(page, personas.booker, window);
  await confirmBookingToPaymentStep(page);

  await payWithCard(page, TEST_CARDS.success);

  await expect(page.getByText("Payment successful!")).toBeVisible({
    timeout: 45_000,
  });

  // Money is committed now, so the paid booking must hold its beds
  // (CAPACITY_HOLDING_BOOKING_STATUSES / issue #737). The banner renders on
  // Stripe's client-side confirmation; the server marks the booking PAID and
  // claims capacity in the success callback just after, so poll instead of
  // sampling instantly.
  for (const night of window.nights) {
    await expect
      .poll(
        async () => (await fetchOccupiedBeds(page, window.nights))[night],
        {
          message: `occupied beds on ${night} after payment`,
          timeout: 20_000,
        },
      )
      .toBe(occupiedBefore[night] + 1);
  }

  // The booking reaches a confirmed state for the member.
  await page.goto("/bookings");
  await expect(page.getByText(/confirmed|paid/i).first()).toBeVisible();
});

test("declined test-mode card leaves the booking payable", async ({ page }) => {
  const window = stayWindow(2);
  await bookSelfToReviewStep(page, personas.booker, window);
  await confirmBookingToPaymentStep(page);

  await payWithCard(page, TEST_CARDS.declined);

  // Stripe surfaces the decline inside the wizard; no success state appears
  // and the member can retry payment.
  await expect(
    page.getByText(/declined|unable to process|payment failed/i).first(),
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Payment successful!")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Pay Now" })).toBeVisible();
});
