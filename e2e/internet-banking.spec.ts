import { type BrowserContext, expect, test } from "@playwright/test";
import { loginPersona } from "./helpers/auth";
import { E2E_ADMIN, IB_BOOKING_ID, WAITLISTER } from "./helpers/fixtures";
import { overrideModules, setModuleSettings, type ModuleSettings } from "./helpers/modules";

// Critical row (docs/END_TO_END_TEST_MATRIX.md): "Internet Banking/Xero invoice
// settlement distinct from Stripe." Xero is deliberately unconfigured in this
// stack (no connection), so switching a card booking to Internet Banking must
// queue the invoice without calling Xero and without crashing.
//
// A card (Stripe) PAYMENT_PENDING booking owned by Wanda is seeded
// (prisma/demo-seed.ts, id IB_BOOKING_ID). Wanda has a complete, confirmed
// profile, so the booking page is not blocked by the onboarding modal. The
// Internet Banking + Xero modules default off, so this spec turns them on for
// its own run and restores them afterwards, leaving the rest of the suite on
// the default card flow.
test.describe.configure({ mode: "serial" });

let memberContext: BrowserContext;
let adminContext: BrowserContext;
let previousModules: ModuleSettings | undefined;

test.beforeAll(async ({ browser }) => {
  // Two fresh logins incl. first-time two-factor enrollment: needs more than
  // the default 90s hook budget on a loaded CI runner.
  test.setTimeout(240_000);
  memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await loginPersona(memberPage, WAITLISTER.email);
  await memberPage.close();

  adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPersona(adminPage, E2E_ADMIN.email);
  // Both flags are required: the switch endpoint 400s unless xeroIntegration
  // and internetBankingPayments are on (src/app/api/payments/switch-to-internet-banking).
  previousModules = await overrideModules(adminContext.request, {
    xeroIntegration: true,
    internetBankingPayments: true,
  });
  await adminPage.close();
});

test.afterAll(async () => {
  try {
    if (adminContext && previousModules) {
      await setModuleSettings(adminContext.request, previousModules);
    }
  } finally {
    await adminContext?.close();
    await memberContext?.close();
  }
});

test("member switches a card booking to Internet Banking with Xero absent", async () => {
  const page = await memberContext.newPage();
  await page.goto(`/bookings/${IB_BOOKING_ID}`);

  // The card PAYMENT_PENDING booking offers the switch once the module is on.
  const switchButton = page.getByRole("button", {
    name: "Pay by internet banking instead",
  });
  await expect(switchButton).toBeVisible();
  await switchButton.click();

  // Deterministic client outcome: the switch affordance retires immediately on
  // success — it can no longer stick on "Switching…" or flash the pre-switch
  // layout back for a paint (the #1148 / #1371 F28 fix). The detail page then
  // refreshes to the Internet Banking card: source Internet Banking with a
  // BOOKING-… reference, and no crash despite Xero being unconfigured (the Xero
  // invoice is queued but never sent while disconnected). The booking stays
  // payment-owed (holdBedSlots defaults off → no bed held, per #737). Asserted
  // against the live DOM with no reload crutch, so a regression fails loudly.
  await expect(switchButton).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText("Internet Banking Payment")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/Reference:/)).toBeVisible();
  await expect(
    page.getByText(`BOOKING-${IB_BOOKING_ID.slice(0, 8).toUpperCase()}`, {
      exact: true,
    }),
  ).toBeVisible();
  await page.close();
});
