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

  // The decline is surfaced to the member either as the app's own error copy
  // ("Your card has been declined.") on the page, or as the Payment Element's
  // inline error inside its Stripe iframe ("Your card was declined."). Accept
  // whichever surface renders — the app confirmed it does render Stripe's
  // error.message on the confirmPayment error branch (#1224).
  const declineCopy =
    /declin|unable to process|payment failed|card (was|has been) declined/i;
  await expect(async () => {
    const appVisible = await page
      .getByText(declineCopy)
      .first()
      .isVisible()
      .catch(() => false);
    let frameVisible = false;
    for (const frame of page.frames()) {
      if (!/stripe/i.test(frame.url())) continue;
      if (
        await frame
          .getByText(declineCopy)
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        frameVisible = true;
        break;
      }
    }
    expect(appVisible || frameVisible).toBe(true);
  }).toPass({ timeout: 45_000 });

  // TEMP(#1224 attribution): once the decline is visible, report which surface
  // rendered it and the exact matched copy, so US CI proves the green is a real
  // "card declined" (not a generic match or a Link/bot-check interception).
  // Revert this block before merge.
  {
    const appLoc = page.getByText(declineCopy).first();
    const appTxt = (await appLoc.isVisible().catch(() => false))
      ? await appLoc.textContent().catch(() => null)
      : null;
    let frameTxt: string | null = null;
    for (const frame of page.frames()) {
      if (!/stripe/i.test(frame.url())) continue;
      const loc = frame.getByText(declineCopy).first();
      if (await loc.isVisible().catch(() => false)) {
        frameTxt = await loc.textContent().catch(() => null);
        break;
      }
    }
    console.log(
      `#1224 ATTRIBUTION app=${JSON.stringify(appTxt)} frame=${JSON.stringify(frameTxt)}`,
    );
  }

  await expect(page.getByText("Payment successful!")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Pay Now" })).toBeVisible();
});
