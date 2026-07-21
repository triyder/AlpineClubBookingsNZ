import { type BrowserContext, expect, test } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import { overrideModules, setModuleSettings, type ModuleSettings } from "./helpers/modules";

// Kept in lockstep with MOCK_XERO_ORG_NAME in src/lib/xero-mock-endpoint.ts.
const MOCK_XERO_ORG_NAME = "Alpine Test Club Ltd";

// Full guided Xero completion flow (#2081), end-to-end against the mock-Xero
// harness (XERO_MOCK_API_ORIGIN, set in .env.staging): from module-on through
// credentials -> connect -> WEBHOOK VERIFY (intent-to-receive) -> mapping ->
// import & finish. The webhook verify is the load-bearing assertion: the mock
// harness POSTs Xero's validation ping to the REAL /api/webhooks/xero route
// (same resolver + HMAC path production uses), and the wizard only goes green on
// that fresh, key-matched marker.
test.describe.configure({ mode: "serial" });

let adminContext: BrowserContext;
let previousModules: ModuleSettings | undefined;

test.beforeAll(async ({ browser }) => {
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

test("operator completes the whole Xero wizard including verified webhooks", async () => {
  const page = await adminContext.newPage();
  await page.goto("/admin/xero/setup");

  // Step 1 — create-app instructions.
  await expect(
    page.getByRole("heading", { name: /create your xero app/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2 — credentials.
  await page.getByLabel("Client ID").fill("mock-client-id");
  await page.getByLabel("Client Secret").fill("mock-client-secret");
  await page.getByRole("button", { name: /save credentials/i }).click();
  await expect(page.getByText(/Both credentials stored/i)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3 — connect (mock OAuth round-trip).
  await expect(
    page.getByRole("heading", { name: /connect to xero/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Connect Xero$/ }).click();
  await expect(page).toHaveURL(/\/admin\/xero\/setup\?connected=true/);
  await expect(
    page.getByText(new RegExp(`Connected to\\s+${MOCK_XERO_ORG_NAME}`, "i")),
  ).toBeVisible({ timeout: 30_000 });

  // Advance to the webhook step. (Connect is verified, so Continue is enabled.)
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 4 — webhooks: save the key, Verify, then have the mock harness send the
  // intent-to-receive ping to the REAL webhook route.
  await expect(
    page.getByRole("heading", { name: /webhooks \(optional\)/i }),
  ).toBeVisible();
  await page.getByLabel(/Webhooks key/i).fill("mock-webhook-signing-key");
  await page.getByRole("button", { name: /^Save key$/ }).click();
  const verifyBtn = page.getByRole("button", { name: "Verify" });
  await expect(verifyBtn).toBeEnabled();
  await verifyBtn.click();

  // Give the wizard a moment to capture its server-issued verify-start, THEN
  // trigger the mock validation ping so its marker is strictly newer (freshness).
  await page.waitForTimeout(500);
  const pingRes = await page.request.post(
    "/api/testing/xero-mock/send-validation",
  );
  expect(pingRes.ok()).toBeTruthy();
  expect((await pingRes.json()).forwarded).toBe(200);

  await expect(page.getByText(/Webhooks verified/i)).toBeVisible({
    timeout: 30_000,
  });

  // The persistent amber badge must be gone once verified.
  await expect(
    page.getByText(/Webhooks not configured/i),
  ).toHaveCount(0);

  // Advance to account mapping — the embedded MappingsPanel renders the mock
  // chart of accounts.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: /map accounts & items/i }),
  ).toBeVisible();
  await expect(page.getByText(/Account Mappings/i)).toBeVisible({
    timeout: 30_000,
  });

  // Advance to import & finish — summary + one-time import tools.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: /import contacts & finish/i }),
  ).toBeVisible();
  await expect(page.getByText(/Setup summary/i)).toBeVisible();
  await expect(page.getByText(/^Verified$/)).toBeVisible();
  // Summary covers org, webhook state AND mappings (#2081 acceptance criteria):
  // the Mappings row reports how many of the mapping keys resolve to a code.
  await expect(page.getByText(/Mappings/)).toBeVisible();
  await expect(page.getByText(/\d+ of \d+ accounts mapped/)).toBeVisible();

  // The whole wizard is now complete.
  await expect(page.getByText(/Setup complete/i)).toBeVisible();

  // Restore a re-runnable state for the sibling wizard spec (this file sorts
  // first, so it runs first): disconnect Xero and rewind the wizard cursor to
  // step one. Credentials stay stored — the sibling spec re-enters them via
  // the Replace flow, which is itself worth exercising.
  const disconnectRes = await page.request.post("/api/admin/xero/disconnect");
  expect(disconnectRes.ok()).toBeTruthy();
  const rewindRes = await page.request.post(
    "/api/admin/integrations/wizard-progress",
    {
      data: {
        wizardId: "xero",
        currentStepId: "create-app",
        completedStepIds: [],
      },
    },
  );
  expect(rewindRes.ok()).toBeTruthy();

  await page.close();
});
