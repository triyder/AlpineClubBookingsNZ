import { type BrowserContext, expect, test, type Page } from "@playwright/test";
import { loginPersona } from "./helpers/auth";
import { bookSelfToReviewStep, confirmBookingToPaymentStep } from "./helpers/booking";
import { personas } from "./helpers/personas";
import { E2E_ADMIN } from "./helpers/fixtures";
import { storageStatePath } from "./helpers/auth";
import { stayWindow } from "./helpers/stay-dates";

// docs/END_TO_END_TEST_MATRIX.md row "Admin date override (#1668)": a Full Admin
// moves the dates of an in-progress and then a fully-past booking via the
// override control, choosing SHIFT (price frozen), and a member never sees the
// control. The over-capacity confirm path (step 5 of the issue spec) is
// deliberately covered at route/unit level instead of here — seeding a full
// window live inside this shared-DB serial suite is the fragile part the issue
// explicitly allows deferring — see admin-shift-booking-dates.test.ts,
// modify-admin-override.test.ts, modify-quote-shift.test.ts,
// modify-quote-recalc-override.test.ts, and
// calculate-modified-pricing-capacity.test.ts. The recalculate override path
// (which this shift-only journey never exercises) is covered by those last two
// plus resolve-target-dates-admin-override.test.ts.
//
// Shift is season-rate independent (it never prices), so this uses a fresh
// member booking on stayWindow(5) (indexes 0–4 are taken by other specs) and
// relies on the admin override to move it into the in-progress and fully-past
// date ranges the normal edit window locks.
test.describe.configure({ mode: "serial" });

const window = stayWindow(5);

let memberContext: BrowserContext;
let adminContext: BrowserContext;
let bookingId = "";

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// The bold "Total" row on the booking Payment card, reduced to its digits so a
// frozen price can be compared across shifts.
async function readTotalDigits(page: Page): Promise<string> {
  const row = page.locator("div.font-bold", { hasText: "Total" }).first();
  await expect(row).toBeVisible();
  return (await row.innerText()).replace(/[^0-9.]/g, "");
}

// Open the admin override editor, choose SHIFT, move the check-in (the check-out
// derives to preserve the night count), and save. Returns after the editor has
// closed on success.
async function adminShiftTo(page: Page, newCheckIn: string): Promise<void> {
  await page.goto(`/bookings/${bookingId}`);
  await page.getByRole("button", { name: "Edit Booking" }).click();

  await page
    .getByRole("checkbox", { name: /Move locked\/past dates \(admin override\)/ })
    .check();
  await page.getByRole("radio", { name: /Shift dates only/ }).check();

  await page.locator("#edit-checkin").fill(newCheckIn);
  // Shift mode derives the check-out from the check-in; give it a tick to settle.
  await expect(page.locator("#edit-checkout")).not.toHaveValue(window.checkOut);

  const save = page.getByRole("button", { name: "Save Changes" });
  await expect(save).toBeEnabled();
  await save.click();

  // On success the editor closes (router.refresh + onDone) and the Stay Details
  // view returns.
  await expect(
    page.getByRole("button", { name: "Save Changes" }),
  ).toHaveCount(0, { timeout: 30_000 });
}

test.beforeAll(async ({ browser }) => {
  // A fresh admin login (incl. first-time two-factor enrollment) needs more than
  // the default hook budget on a loaded runner.
  test.setTimeout(240_000);

  memberContext = await browser.newContext({
    storageState: storageStatePath(personas.booker.email),
  });

  adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPersona(adminPage, E2E_ADMIN.email);
  await adminPage.close();
});

test.afterAll(async () => {
  await memberContext?.close();
  await adminContext?.close();
});

test("member books a future stay for the admin to override", async () => {
  const page = await memberContext.newPage();
  await bookSelfToReviewStep(page, personas.booker, window);
  await confirmBookingToPaymentStep(page);

  // The wizard stays on /book at the in-wizard PayStep (no navigation happens
  // until payment completes), but the booking already exists — follow the
  // PayStep's "View booking details" link to capture its id.
  await page.getByRole("link", { name: "View booking details" }).click();
  await expect(page).toHaveURL(/\/bookings\/[^/]+$/);
  bookingId = new URL(page.url()).pathname.split("/").pop() ?? "";
  expect(bookingId).not.toBe("");
  await page.close();
});

test("admin shifts a future booking into an in-progress stay with the price frozen", async () => {
  const page = await adminContext.newPage();
  await page.goto(`/bookings/${bookingId}`);
  const totalBefore = await readTotalDigits(page);

  // Move check-in to yesterday: a 2-night stay then spans [yesterday, tomorrow),
  // i.e. checkIn <= today < checkOut — a genuinely in-progress booking.
  await adminShiftTo(page, isoDay(-1));

  await page.reload();
  await expect(page.getByRole("button", { name: "Edit Booking" })).toBeVisible();
  // Price unchanged by the shift.
  expect(await readTotalDigits(page)).toBe(totalBefore);
  // Re-open the editor to confirm the persisted check-in moved.
  await page.getByRole("button", { name: "Edit Booking" }).click();
  await expect(page.locator("#edit-checkin")).toHaveValue(isoDay(-1));
  await page.close();
});

test("admin shifts the in-progress booking forward one night (the motivating case)", async () => {
  const page = await adminContext.newPage();
  await page.goto(`/bookings/${bookingId}`);
  const totalBefore = await readTotalDigits(page);

  await adminShiftTo(page, isoDay(0)); // check-in = today

  await page.reload();
  await page.getByRole("button", { name: "Edit Booking" }).click();
  await expect(page.locator("#edit-checkin")).toHaveValue(isoDay(0));
  // Frozen price survives a second shift too.
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(await readTotalDigits(page)).toBe(totalBefore);
  await page.close();
});

test("a member does NOT see the admin override control on their own in-progress booking", async () => {
  const page = await memberContext.newPage();
  await page.goto(`/bookings/${bookingId}`);
  // A member may still edit an in-progress booking (future nights), so the Edit
  // Booking button can show — but the override card must not.
  const editButton = page.getByRole("button", { name: "Edit Booking" });
  if (await editButton.isVisible().catch(() => false)) {
    await editButton.click();
  }
  await expect(
    page.getByRole("checkbox", {
      name: /Move locked\/past dates \(admin override\)/,
    }),
  ).toHaveCount(0);
  await page.close();
});

test("admin moves the booking fully into the past, then shifts it again", async () => {
  const page = await adminContext.newPage();
  await page.goto(`/bookings/${bookingId}`);
  const totalBefore = await readTotalDigits(page);

  // Fully past: check-in 5 days ago → a 2-night stay ends 3 days ago (checkOut
  // <= today), which the member-facing edit window refuses outright.
  await adminShiftTo(page, isoDay(-5));

  await page.reload();
  await page.getByRole("button", { name: "Edit Booking" }).click();
  await expect(page.locator("#edit-checkin")).toHaveValue(isoDay(-5));
  await page.getByRole("button", { name: "Cancel" }).click();

  // Move the fully-past record again (+1 day) — the fully-past path end to end.
  await adminShiftTo(page, isoDay(-4));
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit Booking" })).toBeVisible();
  expect(await readTotalDigits(page)).toBe(totalBefore);
  await page.close();
});
