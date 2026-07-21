import { type BrowserContext, expect, test } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import { overrideModules, setModuleSettings, type ModuleSettings } from "./helpers/modules";

// Kept in lockstep with MOCK_XERO_ORG_NAME in src/lib/xero-mock-endpoint.ts,
// which the gated mock organisation endpoint returns. Duplicated as a literal
// rather than imported so this spec never pulls a server-only module into the
// Playwright transform.
const MOCK_XERO_ORG_NAME = "Alpine Test Club Ltd";

// Guided Xero connection wizard happy path (#2080), driven end-to-end against
// the mock-Xero harness (XERO_MOCK_API_ORIGIN, set in .env.staging). A fresh
// club with only a strong auth secret configured must reach
// "Connected to <Org>" purely in-app: create-app instructions -> enter
// credentials -> OAuth connect -> right-org confirmation.
//
// xeroIntegration defaults OFF (e2e/setup/enable-e2e-modules.ts), so this spec
// turns it on for its own run and restores it in afterAll — the same
// toggle-and-restore choreography the internet-banking spec uses, kept
// non-colliding by workers=1 (playwright.config.ts).
test.describe.configure({ mode: "serial" });

let adminContext: BrowserContext;
let previousModules: ModuleSettings | undefined;

test.beforeAll(async ({ browser }) => {
  // Reuse the Full-Admin session saved once in auth.setup.ts (credential writes
  // are Full-Admin only, #2079 decision 4).
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  previousModules = await overrideModules(adminContext.request, {
    xeroIntegration: true,
  });
});

test.afterAll(async () => {
  try {
    if (adminContext && previousModules) {
      await setModuleSettings(adminContext.request, previousModules);
    }
  } finally {
    await adminContext?.close();
  }
});

test("operator reaches Connected to <Org> entirely in-app", async () => {
  const page = await adminContext.newPage();
  await page.goto("/admin/xero/setup");

  // Step 1 — create-app instructions with copy-paste-exact values.
  await expect(
    page.getByRole("heading", { name: /create your xero app/i }),
  ).toBeVisible();
  // The resolved redirect URI copy field is present (the value the flow sends).
  await expect(page.getByText(/OAuth 2\.0 redirect URI/i)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2 — enter credentials (write-only) → C1 credentials API.
  await expect(
    page.getByRole("heading", { name: /enter your xero credentials/i }),
  ).toBeVisible();
  await page.getByLabel("Client ID").fill("mock-client-id");
  await page.getByLabel("Client Secret").fill("mock-client-secret");
  // "Save credentials" on a fresh club; "Replace credentials" when the
  // completion spec (which runs first) has already stored a pair.
  await page
    .getByRole("button", { name: /(save|replace) credentials/i })
    .click();

  // Verified: both credentials now show "Set ✓" and Continue enables.
  await expect(page.getByText(/Both credentials stored/i)).toBeVisible();
  const continueBtn = page.getByRole("button", { name: "Continue" });
  await expect(continueBtn).toBeEnabled();
  await continueBtn.click();

  // Step 3 — connect: the OAuth flow round-trips through the mock and returns to
  // the wizard, which confirms the connected organisation name.
  await expect(
    page.getByRole("heading", { name: /connect to xero/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Connect Xero$/ }).click();

  // Back on the wizard after the mock OAuth round-trip: right-org confirmation.
  await expect(page).toHaveURL(/\/admin\/xero\/setup\?connected=true/);
  await expect(
    page.getByText(new RegExp(`Connected to\\s+${MOCK_XERO_ORG_NAME}`, "i")),
  ).toBeVisible({ timeout: 30_000 });
  // Connect is verified but the wizard is NOT complete (#2081 extends it with
  // webhooks/mapping/import) — the next step is reachable, and no completion
  // banner shows yet (never "the whole integration is done" mid-flow, #2080
  // UX-F9; the six-step completion state is covered by the completion spec).
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: /webhooks \(optional\)/i }),
  ).toBeVisible();
  await expect(page.getByText(/Setup complete/i)).toHaveCount(0);

  await page.close();
});
