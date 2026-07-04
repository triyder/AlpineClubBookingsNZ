import { expect, test } from "@playwright/test";
import { loginPersona } from "./helpers/auth";
import { ROLE_PERSONAS } from "./helpers/fixtures";

// High row (docs/END_TO_END_TEST_MATRIX.md): "Role boundaries for full admin,
// read-only admin, booking officer, membership officer, Treasurer, content
// manager, finance viewer, and lodge kiosk."
//
// Each persona holds exactly one bundled access role (see prisma/demo-seed.ts +
// src/lib/access-roles.ts). The expectations below come straight from the
// authoritative area matrix in src/lib/admin-permissions.ts (ADMIN_ROLE_BUNDLES)
// and the /finance (finance-auth) and /lodge (kiosk) gates — not invented.
//
// The admin layout redirects an out-of-area request to the persona's first
// accessible admin page (getFirstAccessibleAdminHref) or /dashboard, so a URL
// that stays put == access granted and a URL that moves == blocked. Each test
// gets a clean browser context (no shared storageState) and signs in fresh,
// completing forced two-factor enrollment on the way (the module is global in
// this env).

test.describe.configure({ mode: "serial" });

test("read-only admin views admin areas but not the finance workspace", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_READONLY.email);

  // In-area: every admin area is view-level, so admin pages render.
  await page.goto("/admin/members");
  await expect(page).toHaveURL(/\/admin\/members/);
  await page.goto("/admin/bookings");
  await expect(page).toHaveURL(/\/admin\/bookings/);

  // Out-of-area: read-only admin is not a finance viewer, so the separate
  // /finance workspace bounces it back to the member dashboard.
  await page.goto("/finance");
  await expect(page).toHaveURL(/\/dashboard/);
});

test("booking officer manages bookings but is blocked from content", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_BOOKINGS.email);

  // In-area: bookings = edit.
  await page.goto("/admin/bookings");
  await expect(page).toHaveURL(/\/admin\/bookings/);

  // Out-of-area: content = none → redirected to the overview dashboard.
  await page.goto("/admin/page-content");
  await expect(page).toHaveURL(/\/admin\/dashboard/);
});

test("membership officer manages members but is blocked from content", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_MEMBERSHIP.email);

  // In-area: membership = edit.
  await page.goto("/admin/members");
  await expect(page).toHaveURL(/\/admin\/members/);

  // Out-of-area: content = none → redirected to the overview dashboard.
  await page.goto("/admin/page-content");
  await expect(page).toHaveURL(/\/admin\/dashboard/);
});

test("content manager edits content but is blocked from membership", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_CONTENT.email);

  // In-area: content = edit.
  await page.goto("/admin/page-content");
  await expect(page).toHaveURL(/\/admin\/page-content/);

  // Out-of-area: membership = none, overview = view → redirected to dashboard.
  await page.goto("/admin/members");
  await expect(page).toHaveURL(/\/admin\/dashboard/);
});

test("treasurer edits finance but is blocked from content", async ({ page }) => {
  await loginPersona(page, ROLE_PERSONAS.FINANCE_ADMIN.email);

  // In-area: finance = edit (admin finance pages).
  await page.goto("/admin/payments");
  await expect(page).toHaveURL(/\/admin\/payments/);
  // FINANCE_ADMIN is a finance manager, so the /finance workspace is reachable.
  await page.goto("/finance");
  await expect(page).toHaveURL(/\/finance/);

  // Out-of-area: content = none → redirected to the overview dashboard.
  await page.goto("/admin/page-content");
  await expect(page).toHaveURL(/\/admin\/dashboard/);
});

test("finance viewer reaches the finance workspace but no admin portal", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.FINANCE_USER.email);

  // In-area: FINANCE_USER carries no admin bundle, only finance-viewer access,
  // so its area is the /finance workspace.
  await page.goto("/finance");
  await expect(page).toHaveURL(/\/finance/);

  // Out-of-area: empty admin matrix → any admin page bounces to /dashboard.
  await page.goto("/admin/members");
  await expect(page).toHaveURL(/\/dashboard/);
});

test("lodge role reaches lodge operations but no admin portal", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.LODGE.email);

  // In-area: the kiosk landing.
  await page.goto("/lodge/kiosk");
  await expect(page).toHaveURL(/\/lodge\/kiosk/);

  // Lodge-distinguishing surface: the roster wizard's layout redirects a
  // NON-lodge member to the kiosk, so staying on /lodge/roster proves the
  // LODGE access role specifically (any member can reach the kiosk).
  await page.goto("/lodge/roster/2026-08-15/setup");
  await expect(page).toHaveURL(/\/lodge\/roster\//);

  // Out-of-area: LODGE carries no admin bundle → admin pages bounce away.
  await page.goto("/admin/members");
  await expect(page).toHaveURL(/\/dashboard/);
});
