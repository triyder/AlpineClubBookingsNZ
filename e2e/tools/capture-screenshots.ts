#!/usr/bin/env npx tsx
/**
 * Documentation screenshot harness (issue #2049).
 *
 * Captures a NAMED, stable set of admin and public screenshots into
 * `docs/images/**` for the operator guides (issue #2050). It reuses the seeded
 * staging app that the Playwright E2E suite boots (see docs/E2E_PLAYWRIGHT.md)
 * and the same demo-seed admin persona + two-factor login helpers, so captures
 * are deterministic and re-creatable.
 *
 * ## Prerequisites (same seeded stack as the E2E suite)
 *
 *   npm run test:e2e:prepare      # boots docker staging stack, seeds demo data,
 *                                 # enables the E2E modules, starts the app on
 *                                 # STAGING_HTTP_PORT (default 3001)
 *
 * Then, from the repo root:
 *
 *   npm run docs:screenshots      # capture every manifest entry
 *   npm run docs:screenshots -- --list      # dry run: print the manifest, no browser
 *   npm run docs:screenshots -- admin-dashboard public-home   # capture a subset
 *
 * Environment:
 *   E2E_BASE_URL   target app (default http://localhost:3001, matching E2E)
 *
 * Safety: only ever point this at the local, ephemeral seeded staging stack.
 * Never a live or production deployment — it logs in and navigates admin pages.
 *
 * Output lives under docs/images/<area>/<name>.png with STABLE filenames, so a
 * refresh overwrites in place (a screenshot update is a diff, not a rename).
 * Add a new entry to CAPTURES to grow the set.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { loginPersona, storageStatePath } from "../helpers/auth";
import { E2E_ADMIN } from "../helpers/fixtures";

type Capture = {
  /** Stable filename stem and CLI selector, e.g. "admin-dashboard". */
  name: string;
  /** App path to visit, e.g. "/admin/dashboard". */
  route: string;
  /** Output area subdirectory under docs/images. */
  area: "admin" | "public";
  /** Whether the page requires the admin session (default true). */
  auth?: boolean;
  /** Optional text to wait for before shooting, to avoid loading-state shots. */
  waitForText?: string;
};

// The named set. Admin entries are the hub/landing pages an operator guide most
// often needs; public-home anchors the adopter-facing docs. #2050 extends this.
const CAPTURES: Capture[] = [
  { name: "admin-dashboard", route: "/admin/dashboard", area: "admin" },
  { name: "admin-members", route: "/admin/members", area: "admin" },
  { name: "admin-bookings", route: "/admin/bookings", area: "admin" },
  { name: "admin-bed-allocation", route: "/admin/bed-allocation", area: "admin" },
  { name: "admin-waitlist", route: "/admin/waitlist", area: "admin" },
  { name: "admin-reports", route: "/admin/reports", area: "admin" },
  { name: "admin-setup", route: "/admin/setup", area: "admin" },
  { name: "public-home", route: "/", area: "public", auth: false },
];

const VIEWPORT = { width: 1280, height: 800 } as const;
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3001";
const IMAGES_ROOT = path.resolve(path.join(import.meta.dirname, "..", "..", "docs", "images"));

function outputPath(capture: Capture): string {
  return path.join(IMAGES_ROOT, capture.area, `${capture.name}.png`);
}

function relOut(capture: Capture): string {
  return path.relative(path.resolve(import.meta.dirname, "..", ".."), outputPath(capture)).replace(/\\/g, "/");
}

function parseArgs(argv: string[]): { list: boolean; only: Set<string> } {
  const args = argv.slice(2);
  const list = args.includes("--list") || args.includes("--dry-run");
  const only = new Set(args.filter((a) => !a.startsWith("-")));
  return { list, only };
}

function selected(only: Set<string>): Capture[] {
  if (only.size === 0) return CAPTURES;
  const chosen = CAPTURES.filter((c) => only.has(c.name));
  const unknown = [...only].filter((n) => !CAPTURES.some((c) => c.name === n));
  if (unknown.length > 0) {
    throw new Error(`Unknown capture name(s): ${unknown.join(", ")}. Run with --list to see valid names.`);
  }
  return chosen;
}

function printManifest(captures: Capture[]): void {
  console.log(`Screenshot manifest (${captures.length} entries), base URL ${BASE_URL}:\n`);
  for (const c of captures) {
    console.log(`  ${c.name.padEnd(22)} ${c.route.padEnd(24)} auth=${c.auth === false ? "no " : "yes"}  ->  ${relOut(c)}`);
  }
  console.log(`\nViewport ${VIEWPORT.width}x${VIEWPORT.height}. Output overwrites in place (stable filenames).`);
}

async function shoot(context: BrowserContext, capture: Capture): Promise<void> {
  const page = await context.newPage();
  try {
    // Wait for the document 'load' event (deterministic), not "networkidle":
    // networkidle can hang or resolve arbitrarily on pages with long-poll /
    // streaming / analytics requests. Give it an explicit navigation timeout.
    await page.goto(new URL(capture.route, BASE_URL).toString(), { waitUntil: "load", timeout: 30_000 });
    // Settle: let web fonts finish so text is not captured in a fallback face,
    // bounded by an explicit timeout so a stuck font load cannot block a shot.
    await Promise.race([
      page.evaluate(() => document.fonts.ready.then(() => undefined)),
      page.waitForTimeout(3_000),
    ]);
    if (capture.waitForText) {
      await page.getByText(capture.waitForText).first().waitFor({ state: "visible", timeout: 15_000 });
    }
    const out = outputPath(capture);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out, fullPage: true });
    console.log(`  captured ${capture.name} -> ${relOut(capture)}`);
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const { list, only } = parseArgs(process.argv);
  const captures = selected(only);

  if (list) {
    printManifest(captures);
    return;
  }

  console.log(`Capturing ${captures.length} screenshot(s) against ${BASE_URL} ...`);

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();

    // Admin session: reuse the E2E setup's stored state if present, otherwise
    // log the demo admin in (completing the two-factor gate exactly like the
    // E2E suite). This is the "reuse the seeded-app boot approach" from
    // docs/E2E_PLAYWRIGHT.md — same persona, same login path.
    const adminNeeded = captures.some((c) => c.auth !== false);
    let adminContext: BrowserContext | undefined;
    if (adminNeeded) {
      const statePath = storageStatePath(E2E_ADMIN.email);
      if (fs.existsSync(statePath)) {
        adminContext = await browser.newContext({ baseURL: BASE_URL, viewport: VIEWPORT, storageState: statePath });
      } else {
        // baseURL is REQUIRED here: loginPersona -> submitLoginForm navigates with
        // a relative page.goto("/login") (e2e/helpers/auth.ts), which throws
        // "Cannot navigate to invalid URL" unless the context resolves it against
        // baseURL. This is the path taken whenever the gitignored e2e/.auth state
        // is absent (the documented prepare -> capture flow).
        const bootstrap = await browser.newContext({ baseURL: BASE_URL, viewport: VIEWPORT });
        const page = await bootstrap.newPage();
        await page.goto(new URL("/login", BASE_URL).toString());
        await loginPersona(page, E2E_ADMIN.email);
        // Persist so a re-run (or the E2E suite) can reuse it.
        await bootstrap.storageState({ path: statePath });
        await bootstrap.close();
        adminContext = await browser.newContext({ baseURL: BASE_URL, viewport: VIEWPORT, storageState: statePath });
      }
    }

    const publicContext = await browser.newContext({ baseURL: BASE_URL, viewport: VIEWPORT });

    for (const capture of captures) {
      const ctx = capture.auth === false ? publicContext : adminContext;
      if (!ctx) throw new Error("Admin context unavailable for an authed capture");
      await shoot(ctx, capture);
    }

    await publicContext.close();
    await adminContext?.close();
    console.log("Done.");
  } finally {
    await browser?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
