import { type BrowserContext, expect, test } from "@playwright/test";
import { loginPersona, storageStatePath } from "./helpers/auth";
import {
  E2E_ADMIN,
  WAITLIST_FULL_WINDOW,
  WAITLIST_OFFER_BOOKING_ID,
  WAITLISTER,
} from "./helpers/fixtures";

// High row (docs/END_TO_END_TEST_MATRIX.md): "Waitlist, offer expiry,
// force-confirm, bump/cancel."
//
// Coverage and the deliberate gaps:
//  - Placement: Wanda books a seeded-full September window. The wizard's own
//    client capacity pre-check blocks a KNOWN-full night before its in-wizard
//    waitlist prompt (which only fires on a submit-time race), so placement is
//    driven through the same endpoint the wizard calls after a 409
//    (POST /api/bookings { waitlist: true }) — the faithful server path.
//  - Admin force-confirm: the only admin waitlist mutation, driven through the
//    /admin/waitlist UI (overbook branch, since the night is full).
//  - Member accept offer: a seeded, non-expired WAITLIST_OFFERED booking is
//    accepted through the member offer card.
//  - Offer creation + expiry run ONLY on the in-process scheduler
//    (src/lib/cron-waitlist.ts via instrumentation.node.ts; CRON_ENABLED is off
//    in staging and there is no HTTP waitlist-cron endpoint), so those are not
//    browser-reachable — the offer/expiry STATE is asserted via the admin UI on
//    the seeded (expired) offer instead.
//
// Wanda (not alice) drives this: she is seeded PAID with a complete, confirmed
// profile, so the booking API accepts her without the member-details gate.
test.describe.configure({ mode: "serial" });

let memberContext: BrowserContext;
let adminContext: BrowserContext;

test.beforeAll(async ({ browser }) => {
  // One fresh login (WAITLISTER) incl. possible first-time two-factor
  // enrollment: needs more than the default 90s hook budget on a loaded runner.
  test.setTimeout(240_000);
  memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await loginPersona(memberPage, WAITLISTER.email);
  await memberPage.close();

  // Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
  // per-spec login (#1779).
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
});

test.afterAll(async () => {
  await memberContext?.close();
  await adminContext?.close();
});

test("a full lodge night is refused and the member can join the waitlist", async () => {
  const session = (await (
    await memberContext.request.get("/api/auth/session")
  ).json()) as { user?: { id?: string } };
  const memberId = session.user?.id;
  expect(memberId, "Wanda's session should expose her member id").toBeTruthy();

  const guest = {
    firstName: WAITLISTER.firstName,
    lastName: WAITLISTER.lastName,
    ageTier: "ADULT" as const,
    isMember: true,
    memberId,
    stayStart: WAITLIST_FULL_WINDOW.checkIn,
    stayEnd: WAITLIST_FULL_WINDOW.checkOut,
    nights: WAITLIST_FULL_WINDOW.nights,
  };

  // A plain booking on the seeded-full window is refused for capacity.
  const refused = await memberContext.request.post("/api/bookings", {
    data: {
      checkIn: WAITLIST_FULL_WINDOW.checkIn,
      checkOut: WAITLIST_FULL_WINDOW.checkOut,
      guests: [guest],
    },
  });
  const refusedBody = (await refused.json().catch(() => ({}))) as { code?: string };
  expect(refused.status(), `full night should 409: ${JSON.stringify(refusedBody)}`).toBe(409);
  expect(refusedBody.code).toBe("CAPACITY_EXCEEDED");

  // Opting into the waitlist creates a WAITLISTED booking (the exact retry the
  // /book wizard performs after the 409).
  const waitlisted = await memberContext.request.post("/api/bookings", {
    data: {
      checkIn: WAITLIST_FULL_WINDOW.checkIn,
      checkOut: WAITLIST_FULL_WINDOW.checkOut,
      guests: [guest],
      waitlist: true,
    },
  });
  const waitlistedBody = (await waitlisted.json().catch(() => ({}))) as { status?: string };
  expect(waitlisted.status(), `waitlist opt-in: ${JSON.stringify(waitlistedBody)}`).toBe(201);
  expect(waitlistedBody.status).toBe("WAITLISTED");
});

test("an admin force-confirms the waitlisted booking off the waitlist", async () => {
  const adminPage = await adminContext.newPage();
  await adminPage.goto("/admin/waitlist");
  await expect(adminPage.getByRole("heading", { name: "Waitlist" })).toBeVisible();

  // Force-confirm the booking on the full window.
  const row = adminPage.locator("tr", { hasText: WAITLIST_FULL_WINDOW.checkIn });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /Force Confirm/ }).click();

  // The night is full, so force-confirm surfaces the overbook confirmation.
  await expect(adminPage.getByText(/This will overbook the lodge/)).toBeVisible();
  await adminPage
    .getByRole("button", { name: /Confirm Anyway \(Overbook\)/ })
    .click();

  await expect(
    adminPage.getByText("Force-confirmed overbooked booking"),
  ).toBeVisible();
  await adminPage.close();
});

test("a member accepts a waitlist offer and owes payment", async () => {
  const memberPage = await memberContext.newPage();
  await memberPage.goto(`/bookings/${WAITLIST_OFFER_BOOKING_ID}`);

  const offerCard = memberPage.getByText("A Spot Has Opened Up!");
  await expect(offerCard).toBeVisible();
  await memberPage.getByRole("button", { name: "Confirm Booking" }).click();

  // Deterministic outcome: on success the card triggers a hard reload, so the
  // CTA can never stick on "Confirming…" and the page re-renders from the server
  // to its post-acceptance state — the booking moves off WAITLIST_OFFERED to
  // PAYMENT_PENDING, the "A Spot Has Opened Up!" offer card is gone, and payment
  // is owed (#1371 F28). Asserted against the freshly reloaded DOM.
  await expect(offerCard).toHaveCount(0, { timeout: 30_000 });
  await expect(memberPage.getByText(/payment/i).first()).toBeVisible();
  await memberPage.close();
});

test("the admin waitlist surfaces offer and expiry state", async () => {
  const adminPage = await adminContext.newPage();
  await adminPage.goto("/admin/waitlist");
  await expect(adminPage.getByRole("heading", { name: "Waitlist" })).toBeVisible();

  // The seeded (expired) offer is shown as offered, with its expiry — the state
  // the in-process expiry cron would act on. Offer creation/expiry themselves
  // are not browser-reachable (see the file header).
  await expect(adminPage.getByText(/Waitlist Offered/i).first()).toBeVisible();
  await expect(adminPage.getByText(/Offer expires/i).first()).toBeVisible();
  await adminPage.close();
});
