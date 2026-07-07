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

function storeTwoFactor(email: string, data: StoredTwoFactor): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(twoFactorPath(email), JSON.stringify(data, null, 2));
}

// Each persona logs in from its own synthetic client IP (via x-forwarded-for,
// which getClientIp trusts the same way it trusts the reverse proxy in real
// deployments). Without this, the serial suite's ~20 logins from one runner IP
// exhaust the per-IP login rate limit (10 per 15 min) and late specs stall on
// 429 retries. Deterministic per email so re-logins share their bucket.
function syntheticClientIp(email: string): string {
  let hash = 0;
  for (const ch of email) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `10.99.${(hash >> 8) & 0xff}.${(hash & 0xfe) + 1}`;
}

export async function submitLoginForm(
  page: Page,
  email: string,
  password: string = DEMO_PASSWORD,
): Promise<void> {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": syntheticClientIp(email) });
  await page.goto("/login");
  // The login form transiently duplicates its inputs during hydration: #email
  // briefly resolves to TWO nodes right after a single-node settle. First seen
  // in #1154; recurred on CI for #1189 and #1202, where the race window sits
  // between a count assertion and the subsequent fill. #1207 addresses the
  // suspected root cause — the login page read its query params via
  // useSearchParams(), which forced the form into a Suspense boundary whose
  // hard-load hydration is the likely source of the transient duplicate; the
  // params are now resolved server-side so the form renders deterministically.
  // This ride-through stays as defence in depth:
  // (a) target the first node for every interaction so any residual transient
  // duplicate never trips strict mode, and (b) retry the fill until the typed
  // values stick, so a value dropped by a hydration swap is simply re-entered.
  const emailField = page.locator("#email").first();
  const passwordField = page.locator("#password").first();
  await emailField.waitFor({ state: "visible" });
  await expect(async () => {
    await emailField.fill(email);
    await passwordField.fill(password);
    await expect(emailField).toHaveValue(email);
    await expect(passwordField).toHaveValue(password);
  }).toPass({ timeout: 15_000 });
  // The values stuck, so hydration has settled: a *persistent* duplicate input
  // is a real app bug and must still fail the run.
  await expect(page.locator("#email")).toHaveCount(1);
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
    page.getByRole("heading", { name: "Set up two-factor authentication" }),
  ).toBeVisible();

  const setupKey = page.locator("div.font-mono").first();
  await expect(setupKey).not.toHaveText(/Preparing setup key/);
  const secret = (await setupKey.innerText()).trim();

  await page.locator("#totp-code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Enroll" }).click();

  await expect(
    page.getByRole("heading", { name: "Save your recovery codes" }),
  ).toBeVisible();
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
async function verifyTotp(page: Page, secret: string): Promise<void> {
  await expect(page.getByText("Verify your sign-in")).toBeVisible();
  await page.locator("#two-factor-code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

// Signs a persona in and clears whatever two-factor step the server demands,
// leaving the browser on the post-login destination WITHOUT asserting it is
// /dashboard. Scoped-role personas (finance/lodge/admin officers) can land
// elsewhere, so specs that log in as arbitrary personas use this instead of
// signIn. Enrollment secrets are persisted under e2e/.auth for later logins.
export async function loginPersona(page: Page, email: string): Promise<void> {
  await submitLoginForm(page, email);

  if (page.url().includes("/login/enroll")) {
    await enrollTotp(page, email);
  } else if (page.url().includes("/login/verify")) {
    const stored = readStoredTwoFactor(email);
    if (!stored) {
      throw new Error(
        `${email} is enrolled in two-factor auth but no TOTP secret is stored ` +
          "under e2e/.auth. Reseed the E2E database (npm run test:e2e:prepare).",
      );
    }
    await verifyTotp(page, stored.secret);
  }
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
