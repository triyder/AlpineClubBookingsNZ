import { expect, test } from "@playwright/test";
import { loginPersona } from "./helpers/auth";
import {
  E2E_ADMIN,
  NOMINATOR_TWO,
  PAID_CANCEL_BOOKING_ID,
} from "./helpers/fixtures";

// Critical row (docs/END_TO_END_TEST_MATRIX.md): cancel a paid booking and
// receive the settlement with correct status transitions. A future-dated PAID
// booking owned by Nadia (prisma/demo-seed.ts, id PAID_CANCEL_BOOKING_ID) is
// cancelled with the CREDIT method — deterministic and Stripe-free: the seeded
// SUCCEEDED payment has no additional- or setup-intent fields, so the
// credit-path cancel writes the account credit with zero external calls
// (src/lib/booking-cancel.ts). This spec asserts the MONEY OUTCOME — the point
// of the row, and the guard for the P0-1/P0-2 cancel-refund fixes:
//   1. the member's booking flips to CANCELLED with a positive account credit
//      (inline component state, then the reloaded Cancellation Outcome card);
//   2. the admin payments ledger records the credit as an "Account credit"
//      settlement.
//
// Nadia (not Wanda/Alice) owns the booking: no other spec asserts Nadia's
// bookings or account credit — she only drives a nomination in
// membership-application.spec — so cancelling it and crediting her account
// cannot perturb another spec in the serial suite.
//
// Card-refund (real Stripe refund) coverage is intentionally NOT added here: it
// requires Stripe test-mode keys and the datacenter-IP flake mitigations of
// stripe-payment.spec, which would destabilise this otherwise-deterministic
// money-outcome check. Card refund stays Vitest/service-only (see the matrix).
test.describe.configure({ mode: "serial" });

test("member cancels a paid booking for account credit and the money outcome is recorded", async ({
  browser,
}) => {
  // A fresh Nadia login enrolls TOTP on a clean database; the admin login below
  // usually only verifies (a prior spec enrolled E2E_ADMIN), but budget for both.
  test.setTimeout(180_000);

  // ── Member: cancel the paid booking, holding the amount as account credit ──
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await loginPersona(memberPage, NOMINATOR_TWO.email);

  await memberPage.goto(`/bookings/${PAID_CANCEL_BOOKING_ID}`);

  // Open the cancellation preview.
  await memberPage.getByRole("button", { name: "Cancel Booking" }).click();
  await expect(memberPage.getByText("Cancellation Summary")).toBeVisible();

  // Choose the account-credit refund method (native radio, value="credit"),
  // then confirm. Credit is deterministic and never calls Stripe.
  await memberPage.locator('input[type="radio"][value="credit"]').check();
  // Wait for the selection to propagate into the preview BEFORE confirming — the
  // summary label reads "Credit to account:" only while refundMethod==="credit"
  // (cancel-booking-button.tsx). Without this the Confirm click can race the
  // React state update and POST the default refundMethod:"card", which cancels
  // via the card branch and renders the card-refund line instead of the credit
  // line this spec asserts (the intermittent failure this guards against).
  await expect(
    memberPage.getByText("Credit to account:"),
  ).toBeVisible();
  await memberPage
    .getByRole("button", { name: "Confirm Cancellation" })
    .click();

  // Inline component-state outcome (no reload needed): success + the credit
  // line. The credit line only renders for a POSITIVE credit refund, so the
  // dollar match proves a real money outcome, not a $0 no-op.
  await expect(
    memberPage.getByText("Booking cancelled successfully"),
  ).toBeVisible();
  await expect(
    memberPage.getByText(/A credit of \$\d+\.\d{2} has been added/),
  ).toBeVisible();

  // Money outcome #1: a hard reload re-renders the server page (router.refresh()
  // is a soft refresh; the waitlist/IB specs use a hard reload for badge/DOM
  // assertions). The booking is now CANCELLED — proven by the Cancellation
  // Outcome card, which only renders for a CANCELLED booking — with the
  // account-credit settlement row, and the cancel affordance is gone.
  await memberPage.reload();
  await expect(
    memberPage.getByRole("main").getByText("Cancellation Outcome").last(),
  ).toBeVisible();
  await expect(
    memberPage.getByRole("main").getByText("Held as account credit:").last(),
  ).toBeVisible();
  await expect(
    memberPage.getByRole("button", { name: "Cancel Booking" }),
  ).toHaveCount(0);

  await memberPage.close();
  await memberContext.close();

  // ── Admin: the credit settlement lands in the payments ledger ──
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPersona(adminPage, E2E_ADMIN.email);

  await adminPage.goto(
    `/admin/payments?${new URLSearchParams({
      search: NOMINATOR_TWO.email,
      lastUpdatedFrom: "2026-01-01",
      lastUpdatedTo: "2026-12-31",
      settlement: "accountCredit",
    })}`,
  );
  // The explicit updated range avoids the page's rolling "today" filter hiding
  // rows just after midnight NZ in CI, while the email and settlement filters
  // keep the assertion unambiguous.

  // The row shows the member as "lastName, firstName" and its settlement badge
  // reads "Account credit" (deriveSettlementKind → accountCredit for a
  // credit-method cancel; src/lib/admin-operational-state.ts).
  await expect(
    adminPage.getByText(
      `${NOMINATOR_TWO.lastName}, ${NOMINATOR_TWO.firstName}`,
    ),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    adminPage.getByText("Account credit", { exact: true }).first(),
  ).toBeVisible();

  await adminPage.close();
  await adminContext.close();
});
