import { expect, test, type BrowserContext } from "@playwright/test";
import { loginPersona } from "../helpers/auth";
import { E2E_ADMIN, ROSTER_GUEST_LODGE_A, SECOND_LODGE } from "../helpers/fixtures";
import { overrideModules, setModuleSettings } from "../helpers/modules";

// Multi-lodge lobby display scoping (fork epic hoppers99#25, LTV-010): a
// display device created for lodge B renders LODGE B's board — its header
// names lodge B, and lodge A's content never appears. Runs ONLY in the
// `multi-lodge` project against the two-lodge database.
//
// The seeded cross-lodge arrivals (ROSTER_ISOLATION_WINDOW) sit on fixed
// August dates outside the display's rolling today+N window, so the
// PRESENCE of lodge B guests is not assertable here; the data-level
// cross-lodge proof (a lodge A device token never receives lodge B
// bookings/guests/chores/config) is pinned by the display-state route tests
// (src/lib/__tests__/lodge-display-state.test.ts — scoping assertion).

test.describe.configure({ mode: "serial" });

const deviceName = `E2E Lodge B TV ${Date.now()}`;
let previousModules: Record<string, boolean> | null = null;
let tvContext: BrowserContext | null = null;

test.afterAll(async ({ request }) => {
  if (previousModules) {
    await setModuleSettings(request, previousModules).catch(() => undefined);
  }
  await tvContext?.close();
});

test("a device bound to lodge B renders lodge B's board and never lodge A's content", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await loginPersona(page, E2E_ADMIN.email);
  previousModules = await overrideModules(page.request, { lobbyDisplay: true });

  // Create a device explicitly bound to lodge B via the lodge picker.
  await page.goto("/admin/display");
  await page.locator("#device-name").fill(deviceName);
  await page.locator("#device-lodge").selectOption({ label: SECOND_LODGE.name });
  await page.getByRole("button", { name: "Create device" }).click();
  await expect(
    page.getByText(SECOND_LODGE.name).first()
  ).toBeVisible();

  // Pair an unauthenticated TV against it.
  tvContext = await browser.newContext();
  const tv = await tvContext.newPage();
  await tv.goto("/display");
  const codeLocator = tv.locator(".display-pairing-code");
  await expect(codeLocator).toBeVisible({ timeout: 30_000 });
  const code = (await codeLocator.innerText()).trim();

  await page.getByPlaceholder("TV code").fill(code);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByText(/Pairing armed/)).toBeVisible();

  // The board renders LODGE B: its name in the header, and lodge A's
  // seeded guest never present anywhere in the page.
  const header = tv.locator(".display-lodge-name");
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(header).toHaveText(SECOND_LODGE.name);
  await expect(
    tv.getByText(ROSTER_GUEST_LODGE_A.firstName, { exact: false })
  ).toHaveCount(0);
});
