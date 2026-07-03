import { test as setup } from "@playwright/test";
import { signIn, storageStatePath } from "./helpers/auth";
import { personas } from "./helpers/personas";

// Signs the booking persona in once (completing TOTP enrollment on a freshly
// seeded database) and saves the browser storage state for the booking and
// payment specs. The two-factor spec deliberately does not reuse this state —
// it drives login itself with its own persona.
setup("sign in booking persona", async ({ page }) => {
  await signIn(page, personas.booker);
  await page.context().storageState({ path: storageStatePath(personas.booker.email) });
});
