import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import * as OTPAuth from "otpauth";
import { DEMO_PASSWORD, type Persona } from "./personas";

// Matches the app's TOTP parameters (src/lib/two-factor.ts): SHA1, 6 digits,
// 30-second period.
export function totpCode(secretBase32: string): string {
  return new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate();
}

// A six-digit code guaranteed invalid for this secret right now: the server
// accepts a ±1-period window, so avoid all three candidate codes.
export function wrongTotpCode(secretBase32: string): string {
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  const now = Date.now();
  const valid = new Set([
    totp.generate({ timestamp: now - 30_000 }),
    totp.generate({ timestamp: now }),
    totp.generate({ timestamp: now + 30_000 }),
  ]);
  for (const candidate of ["000000", "111111", "222222", "333333"]) {
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error("Could not derive an invalid TOTP code");
}

export type StoredTwoFactor = {
  secret: string;
  recoveryCodes: string[];
};

const AUTH_DIR = path.join(__dirname, "..", ".auth");

function twoFactorPath(email: string): string {
  return path.join(AUTH_DIR, `${email.split("@")[0]}.two-factor.json`);
}

export function storageStatePath(email: string): string {
  return path.join(AUTH_DIR, `${email.split("@")[0]}.state.json`);
}

export function readStoredTwoFactor(email: string): StoredTwoFactor | null {
  const file = twoFactorPath(email);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as StoredTwoFactor;
}

export function storeTwoFactor(email: string, data: StoredTwoFactor): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(twoFactorPath(email), JSON.stringify(data, null, 2));
}

export function clearStoredTwoFactor(email: string): void {
  fs.rmSync(twoFactorPath(email), { force: true });
}

export async function submitLoginForm(
  page: Page,
  email: string,
  password: string = DEMO_PASSWORD,
): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Password sign-in always continues somewhere: the two-factor gate, a forced
  // password change, or the post-login destination.
  await page.waitForURL(/\/(login\/(enroll|verify)|change-password|dashboard)/);
}

// Completes TOTP enrollment on /login/enroll: reads the on-page manual setup
// key, answers with a generated authenticator code, and captures the recovery
// codes. Leaves the browser on the post-login destination.
export async function enrollTotp(page: Page, email: string): Promise<StoredTwoFactor> {
  await expect(
    page.getByText("Set up two-factor authentication"),
  ).toBeVisible();

  const setupKey = page.locator("div.font-mono").first();
  await expect(setupKey).not.toHaveText(/Preparing setup key/);
  const secret = (await setupKey.innerText()).trim();

  await page.locator("#totp-code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Enroll" }).click();

  await expect(page.getByText("Save your recovery codes")).toBeVisible();
  const recoveryCodes = (
    await page.locator("div.font-mono > div").allInnerTexts()
  ).map((code) => code.trim());
  expect(recoveryCodes.length).toBeGreaterThan(0);

  const stored = { secret, recoveryCodes };
  storeTwoFactor(email, stored);

  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  return stored;
}

// Answers the /login/verify challenge with a TOTP code for the stored secret.
export async function verifyTotp(page: Page, secret: string): Promise<void> {
  await expect(page.getByText("Verify your sign-in")).toBeVisible();
  await page.locator("#two-factor-code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

// Full sign-in for a persona: password, then whichever two-factor step the
// server demands. Enrollment secrets are persisted under e2e/.auth so later
// logins in the same run (and re-runs without a database reset) can verify.
export async function signIn(page: Page, persona: Persona): Promise<void> {
  await submitLoginForm(page, persona.email);

  if (page.url().includes("/login/enroll")) {
    await enrollTotp(page, persona.email);
  } else if (page.url().includes("/login/verify")) {
    const stored = readStoredTwoFactor(persona.email);
    if (!stored) {
      throw new Error(
        `${persona.email} is already enrolled in two-factor auth but no TOTP secret ` +
          "is stored under e2e/.auth. Reset and reseed the E2E database " +
          "(npm run test:e2e:prepare) or restore the stored secret.",
      );
    }
    await verifyTotp(page, stored.secret);
  }

  await expect(page).toHaveURL(/\/dashboard/);
}
