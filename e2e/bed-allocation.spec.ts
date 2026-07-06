import { type BrowserContext, expect, test } from "@playwright/test";
import { loginPersona } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";

// High row (docs/END_TO_END_TEST_MATRIX.md): "Approve a review-flagged booking,
// then allocate its guests to specific beds." The seeded AWAITING_REVIEW booking
// bReview (owner Ken King, adminReviewStatus PENDING, nights 2026-07-30/07-31 —
// prisma/demo-seed.ts) is approved through the admin approvals panel, then Ken's
// guest is placed on a specific bed via the manual Select + Allocate path (NOT
// drag-and-drop) on the bed-allocation board, and the manual draft placement is
// approved.
//
// Auto-allocation is turned OFF for this run: the E2E stack seeds no
// BedAllocationSettings row, so it defaults ON, and approval's
// reconcileBedAllocationsForBooking would otherwise auto-place Ken (removing him
// from the "awaiting allocation" bucket the manual path drives). The setting is
// restored afterwards; no other spec touches bed allocation.
test.describe.configure({ mode: "serial" });

let adminContext: BrowserContext;

test.beforeAll(async ({ browser }) => {
  // A fresh E2E_ADMIN login may enroll TOTP on a clean database.
  test.setTimeout(180_000);
  adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPersona(adminPage, E2E_ADMIN.email);

  // Disable auto-allocation so approval parks Ken in the manual bucket.
  const disabled = await adminContext.request.put(
    "/api/admin/bed-allocation/settings",
    { data: { autoAllocationEnabled: false } },
  );
  expect(
    disabled.ok(),
    `disable auto-allocation (${disabled.status()})`,
  ).toBeTruthy();
  await adminPage.close();
});

test.afterAll(async () => {
  try {
    if (adminContext) {
      // Restore the default (schema default is true).
      await adminContext.request.put("/api/admin/bed-allocation/settings", {
        data: { autoAllocationEnabled: true },
      });
    }
  } finally {
    await adminContext?.close();
  }
});

test("an admin approves a review-flagged booking then allocates a bed to its guest", async () => {
  const page = await adminContext.newPage();

  // ── Approve Ken King's review-flagged booking ──
  // /admin/booking-approvals redirects to /admin/booking-requests?tab=approvals;
  // the approvals panel defaults to the PENDING filter, where Ken's card sits.
  await page.goto("/admin/booking-approvals");
  await expect(page).toHaveURL(/\/admin\/booking-requests/);
  await expect(
    page.getByText("Ken King", { exact: true }).first(),
  ).toBeVisible({ timeout: 30_000 });

  // "Approve" (exact) so it never matches the "Approved" status-filter button.
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Booking approved.")).toBeVisible();

  // ── Allocate Ken's guest to Bunk Room A / A1 via Select + Allocate ──
  await page.goto("/admin/bed-allocation?from=2026-07-30&to=2026-08-01");
  await expect(
    page.getByRole("heading", { name: "Bed Allocation" }),
  ).toBeVisible();

  // Ken's guest chip in the "awaiting allocation" bucket. Both the booking card
  // and the inner guest chip carry "Ken King" + an Allocate button, so .last()
  // resolves to the innermost (the guest chip).
  const kenChip = page
    .locator("div")
    .filter({ hasText: "Ken King" })
    .filter({ has: page.getByRole("button", { name: "Allocate" }) })
    .last();
  await expect(kenChip).toBeVisible({ timeout: 30_000 });

  // Open the bed Select (Radix combobox, placeholder "Select bed") and choose a
  // free bed by its "<room> / <bed>" option label, then Allocate.
  await kenChip.getByRole("combobox").click();
  await page
    .getByRole("option", { name: "Bunk Room A / A1", exact: true })
    .click();
  await kenChip.getByRole("button", { name: "Allocate" }).click();
  await expect(page.getByText("Allocation saved")).toBeVisible();

  // The board now shows Ken on a bed as a MANUAL, still-Draft allocation. "Draft"
  // is asserted exact so it never matches the "N draft allocations to approve"
  // summary badge (lowercase "draft").
  await expect(page.getByText("Ken King").first()).toBeVisible();
  await expect(page.getByText("MANUAL").first()).toBeVisible();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

  // ── Approve the visible draft allocations ──
  await page.getByRole("button", { name: "Approve Visible" }).click();
  await expect(page.getByText("Allocations approved")).toBeVisible();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

  await page.close();
});
