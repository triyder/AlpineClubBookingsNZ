import { expect, test, type Page } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { selectCalendarDay } from "./helpers/booking";
import { E2E_ADMIN } from "./helpers/fixtures";
import {
  assertNoEmailToDomain,
  clearMailbox,
  waitForEmail,
} from "./helpers/mailpit";
import { seasonForWindow, stayWindow, type StayWindow } from "./helpers/stay-dates";
import { clubConfig } from "../src/config/club";
import { PLACEHOLDER_CONTACT_EMAIL_DOMAIN } from "../src/lib/placeholder-contact-email";

// docs/END_TO_END_TEST_MATRIX.md — Book on Behalf (non-member), E9 (#1935),
// live-app follow-up (#1962). The admin non-member Book-on-Behalf flow has
// strong vitest coverage (non-member-contact, placeholder-contact-email,
// placeholder-recipient-suppression, non-member-pricing-parity); this spec
// drives the same journey through the real Next.js app against the staging
// compose stack, exercising the five acceptance items:
//   1. inline create of a non-login non-member contact, then book it;
//   2. suggest-and-pick REUSE of that existing contact (dedupe, never silent);
//   3. no-email WALK-IN owner (club-internal placeholder + email suppression);
//   4. NON-MEMBER pricing applied (the on-behalf quote forces the owner's typed
//      guests to non-member rates — the quote response carries isMember:false);
//   5. NO owner confirmation email for a placeholder-email walk-in owner, with
//      the real-email non-member owner as the positive contrast (they DO get the
//      standard "Booking Pending" hold email when the officer opts in).
//
// The whole non-member owner path funnels a NON_MEMBER guest through create, so
// the booking is held PENDING (nonMemberHoldUntil) and the owner notification is
// the "Booking Pending - …" hold email (src/lib/booking-create.ts →
// sendBookingPendingEmail), gated on the per-create notifyMember choice.
//
// Auth: reuse the E2E full admin's saved storage state (auth.setup.ts) — a full
// admin holds bookings:edit, the scope the non-member-contact endpoint and the
// on-behalf create both require. Reusing the saved session (rather than a fresh
// UI login) keeps this spec off the login rate-limit ceiling (#1779).
//
// Windows: indexes 6/7/8 — disjoint from every other stayWindow spec (0–5). A
// PENDING non-member booking holds no capacity (#737/#738), so these never
// perturb other specs' availability, but distinct windows keep the flow
// deterministic regardless of run date.

test.describe.configure({ mode: "serial" });
test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

// A run-unique real email for the inline-created non-member owner. Test 1
// creates the contact with it; Test 2 types the SAME address to trigger the
// dedupe suggestion and reuse the exact contact. Uniqueness keeps re-runs
// against a non-reseeded database from piling up duplicate suggestions.
const RUN = Date.now();
const REAL_OWNER = {
  firstName: "Nella",
  lastName: "Nonmember",
  email: `nella.nonmember.${RUN}@example.test`.toLowerCase(),
};
const WALK_IN_OWNER = {
  firstName: "Walt",
  lastName: "Walkin",
};

// Captured in Test 1's inline create; Test 2 asserts the reuse suggestion
// returns this EXACT contact id (dedupe, not a fresh duplicate). Safe under
// serial mode — Test 1 always runs (and sets this) before Test 2.
let createdContactId = "";

// A priced quote as returned by /api/bookings/quote (subset this spec reads).
type NonMemberQuote = {
  guests: { isMember: boolean; ageTier: string; priceCents: number }[];
  totalPriceCents: number;
};

// Assert the quote was priced at NON-MEMBER rates by matching the EXACT total
// the seeded club config implies for the booked window — and prove that total is
// distinct from the member-rate total, so the assertion pins the rate COLUMN
// rather than merely "some positive price". Both the season and the cents derive
// from live sources, so the check is date-safe:
//   - season = seasonForWindow(window): the window's actual nights decide winter
//     vs summer (an index can drift between seasons as the run date advances);
//   - rates = clubConfig: the SAME loadClubConfig() the E2E stack's prisma/seed
//     reads its SeasonRate rows from, resolved from the repo-root cwd shared by
//     the seed and this test (config/club.json, else club.example.json) — so the
//     expected cents equal the seeded rates the app actually quotes, with no
//     hardcoded magic number and no hardcoded season.
function assertNonMemberPricing(quote: NonMemberQuote, window: StayWindow): void {
  expect(quote.guests.length).toBeGreaterThan(0);
  expect(quote.guests.every((g) => g.isMember === false)).toBeTruthy();

  const season = seasonForWindow(window);
  const nights = window.nights.length;
  const nightlyCents = (
    tier: string,
    column: "memberCents" | "nonMemberCents",
  ): number => {
    const ageTier = clubConfig.ageTiers.find((t) => t.id === tier);
    if (!ageTier) throw new Error(`no club-config rate for age tier "${tier}"`);
    return ageTier.nightlyRates[season][column];
  };
  const expectedNonMemberTotal = quote.guests.reduce(
    (sum, g) => sum + nights * nightlyCents(g.ageTier, "nonMemberCents"),
    0,
  );
  const expectedMemberTotal = quote.guests.reduce(
    (sum, g) => sum + nights * nightlyCents(g.ageTier, "memberCents"),
    0,
  );
  // Discriminating guard: for these tiers/season the two columns differ, so an
  // exact match on the non-member total proves the non-member column drove the
  // quote — a member-priced quote (the pre-#1935 bug shape) would fail here.
  expect(expectedNonMemberTotal).not.toBe(expectedMemberTotal);
  expect(quote.totalPriceCents).toBe(expectedNonMemberTotal);
}

async function openBookOnBehalf(page: Page): Promise<void> {
  await page.goto("/admin/book");
  await expect(
    page.getByRole("heading", { name: "Book on Behalf of Member" }),
  ).toBeVisible();
  // Switch the owner toggle from "Existing member" to the inline non-member form.
  await page.getByRole("button", { name: "Non-member booking" }).click();
  await expect(page.getByText("Non-member booking owner")).toBeVisible();
}

// From the "Select Dates" step: pick the window, add one typed non-member guest,
// then Continue and return the parsed /api/bookings/quote response so the caller
// can assert non-member pricing was applied.
async function pickDatesAddGuestAndQuote(
  page: Page,
  window: { checkIn: string; checkOut: string },
  guest: { firstName: string; lastName: string },
): Promise<NonMemberQuote> {
  await expect(page.getByText("Select Dates", { exact: true })).toBeVisible();
  await selectCalendarDay(page, window.checkIn);
  await selectCalendarDay(page, window.checkOut);

  // A non-member owner has no family quick-add, so the officer types the guest.
  await page.getByRole("button", { name: "+ Add Non-Member Guest" }).click();
  await page.getByPlaceholder("First name").fill(guest.firstName);
  await page.getByPlaceholder("Last name").fill(guest.lastName);

  const [quoteResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/bookings/quote") &&
        r.request().method() === "POST",
      { timeout: 30_000 },
    ),
    page.getByRole("button", { name: "Continue", exact: true }).click(),
  ]);
  expect(
    quoteResponse.ok(),
    `non-member quote (${quoteResponse.status()})`,
  ).toBeTruthy();
  return quoteResponse.json();
}

test("inline-creates a non-member owner, prices them as a non-member, and emails a real-email owner on opt-in", async ({
  page,
}) => {
  const window = stayWindow(6);
  await openBookOnBehalf(page);

  // (1) Inline create of a non-login non-member contact.
  await page.getByLabel("First name", { exact: true }).fill(REAL_OWNER.firstName);
  await page.getByLabel("Last name", { exact: true }).fill(REAL_OWNER.lastName);
  await page.getByLabel("Email", { exact: true }).fill(REAL_OWNER.email);

  // Capture the create response so Test 2 can prove suggest-and-pick reuses THIS
  // exact contact (dedupe) rather than minting a duplicate. The route returns
  // { contact, reused:false } at 201 for a fresh inline create
  // (src/app/api/admin/bookings/non-member-contact/route.ts).
  const [contactResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/admin/bookings/non-member-contact") &&
        r.request().method() === "POST",
      { timeout: 30_000 },
    ),
    page.getByRole("button", { name: "Create new & continue" }).click(),
  ]);
  expect(
    contactResponse.status(),
    `inline non-member contact create (${contactResponse.status()})`,
  ).toBe(201);
  const created = await contactResponse.json();
  expect(created.reused).toBe(false);
  createdContactId = created.contact.id as string;
  expect(createdContactId).toBeTruthy();

  // The owner is selected and the wizard advances exactly like a member owner.
  await expect(
    page.getByText(
      `Booking on behalf of: ${REAL_OWNER.firstName} ${REAL_OWNER.lastName}`,
    ),
  ).toBeVisible();

  // (4) Non-member pricing applied: the on-behalf quote forces the owner's typed
  // guests to non-member rates, so every priced guest comes back isMember:false.
  const quote = await pickDatesAddGuestAndQuote(page, window, {
    firstName: REAL_OWNER.firstName,
    lastName: REAL_OWNER.lastName,
  });
  assertNonMemberPricing(quote, window);

  await expect(page.getByText("Booking Summary")).toBeVisible();
  // The review reflects the non-member classification that drove the pricing.
  await expect(page.getByText(/\(ADULT, Non-member\)/)).toBeVisible();
  await expect(
    page.getByText(/This booking includes non-member guests/),
  ).toBeVisible();

  // (5, positive contrast) A real-email non-member owner DOES receive the
  // standard hold email when the officer opts in. Clear the mailbox so the
  // captured "Booking Pending" message is unambiguously this create's.
  await clearMailbox();
  await page.getByRole("button", { name: "Confirm Booking" }).click();

  // The non-member variant of the per-create email-choice dialog opens; take the
  // opt-in ("Create and email them"). Gate on the actionable button so the step
  // is robust to the dialog's exact title markup.
  const emailThem = page.getByRole("button", { name: "Create and email them" });
  await expect(emailThem).toBeVisible();

  const [createResponse] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/bookings") && r.request().method() === "POST",
      { timeout: 30_000 },
    ),
    emailThem.click(),
  ]);
  expect(
    createResponse.status(),
    `non-member on-behalf create (${createResponse.status()})`,
  ).toBe(201);
  await expect(page).toHaveURL(/\/bookings\/[A-Za-z0-9-]+$/);

  // The owner's real address receives the "Booking Pending - …" hold email.
  const email = await waitForEmail(REAL_OWNER.email, "Booking Pending");
  expect(email.to.map((a) => a.toLowerCase())).toContain(REAL_OWNER.email);
});

test("suggest-and-pick reuses the existing non-member contact instead of duplicating it", async ({
  page,
}) => {
  const window = stayWindow(7);
  await openBookOnBehalf(page);

  // (2) Dedupe = suggest-and-pick: typing the same email the previous test used
  // surfaces the existing non-login contact as a reuse suggestion.
  await page.getByLabel("Email", { exact: true }).fill(REAL_OWNER.email);
  await expect(
    page.getByText("Existing contacts — reuse one instead of creating a duplicate:"),
  ).toBeVisible();
  await expect(
    page.getByText(`${REAL_OWNER.firstName} ${REAL_OWNER.lastName}`),
  ).toBeVisible();

  // Reuse it explicitly (never silent reuse) — the POST validates the contact
  // and returns it as the booking owner.
  const [reuseResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/admin/bookings/non-member-contact") &&
        r.request().method() === "POST",
      { timeout: 30_000 },
    ),
    page.getByRole("button", { name: "Use existing" }).first().click(),
  ]);
  expect(
    reuseResponse.ok(),
    `reuse existing contact (${reuseResponse.status()})`,
  ).toBeTruthy();

  // Dedupe PROVEN: the route returns { contact, reused:true } and the returned
  // contact is the SAME record Test 1 created — not a duplicate minted from the
  // re-typed email (route.ts → reuseNonMemberContact, non-member-contact.ts).
  const reused = await reuseResponse.json();
  expect(reused.reused).toBe(true);
  expect(reused.contact.id).toBe(createdContactId);

  await expect(
    page.getByText(
      `Booking on behalf of: ${REAL_OWNER.firstName} ${REAL_OWNER.lastName}`,
    ),
  ).toBeVisible();

  // The reused owner books through the identical flow at non-member rates.
  const quote = await pickDatesAddGuestAndQuote(page, window, {
    firstName: "Reused",
    lastName: "Guest",
  });
  assertNonMemberPricing(quote, window);

  await expect(page.getByText("Booking Summary")).toBeVisible();
  await page.getByRole("button", { name: "Confirm Booking" }).click();
  const [createResponse] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/bookings") && r.request().method() === "POST",
      { timeout: 30_000 },
    ),
    // Keep this leg email-free; the owner-email contract is asserted elsewhere.
    page.getByRole("button", { name: "Create without emailing" }).click(),
  ]);
  expect(
    createResponse.status(),
    `reused-owner create (${createResponse.status()})`,
  ).toBe(201);
  await expect(page).toHaveURL(/\/bookings\/[A-Za-z0-9-]+$/);
});

test("a no-email walk-in owner is created with a placeholder and never emailed", async ({
  page,
}) => {
  const window = stayWindow(8);
  await openBookOnBehalf(page);

  // (3) No-email walk-in: name only, "No email address" ticked. The server
  // stores a club-internal placeholder (…@no-email.invalid) and the email field
  // is disabled.
  await page
    .getByLabel("First name", { exact: true })
    .fill(WALK_IN_OWNER.firstName);
  await page.getByLabel("Last name", { exact: true }).fill(WALK_IN_OWNER.lastName);
  await page.getByRole("checkbox", { name: /No email address/ }).check();
  await expect(page.getByLabel("Email", { exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Create new & continue" }).click();
  await expect(
    page.getByText(
      `Booking on behalf of: ${WALK_IN_OWNER.firstName} ${WALK_IN_OWNER.lastName}`,
    ),
  ).toBeVisible();

  const quote = await pickDatesAddGuestAndQuote(page, window, {
    firstName: WALK_IN_OWNER.firstName,
    lastName: WALK_IN_OWNER.lastName,
  });
  assertNonMemberPricing(quote, window);

  await expect(page.getByText("Booking Summary")).toBeVisible();

  // (5) A placeholder-email owner has no email choice to make: Confirm creates
  // immediately (no notify dialog) and the server sends no owner email at all.
  // Clear the mailbox first so any leaked placeholder-recipient send would be
  // caught fresh.
  await clearMailbox();
  const [createResponse] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/bookings") && r.request().method() === "POST",
      { timeout: 30_000 },
    ),
    page.getByRole("button", { name: "Confirm Booking" }).click(),
  ]);
  expect(
    createResponse.status(),
    `walk-in create (${createResponse.status()})`,
  ).toBe(201);
  await expect(page).toHaveURL(/\/bookings\/[A-Za-z0-9-]+$/);

  // No confirmation/hold email is ever addressed to the reserved placeholder
  // domain — the walk-in owner is never emailed.
  await assertNoEmailToDomain(PLACEHOLDER_CONTACT_EMAIL_DOMAIN);
});
