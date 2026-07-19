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
import { E2E_ADMIN, WAITLISTER } from "../helpers/fixtures";

type Capture = {
  /** Stable filename stem and CLI selector, e.g. "admin-dashboard". */
  name: string;
  /** App path to visit, e.g. "/admin/dashboard". */
  route: string;
  /** Output area subdirectory under docs/images. */
  area: "admin" | "public";
  /** Whether the page requires an authenticated session (default true). */
  auth?: boolean;
  /**
   * Which signed-in persona to shoot the page as (ignored when `auth` is
   * false). "admin" (the default) uses the demo E2E admin; "member" uses the
   * seeded complete-profile member (WAITLISTER / Wanda) so batch-5 member
   * journey pages render exactly as a real member sees them. Kept generic:
   * add a member capture by setting `persona: "member"`, not a new context.
   */
  persona?: "admin" | "member";
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
  // Batch 1 (#2050): bookings & capacity operator guides.
  { name: "admin-book", route: "/admin/book", area: "admin" },
  { name: "admin-booking-requests", route: "/admin/booking-requests?tab=approvals", area: "admin" },
  { name: "admin-booking-requests-changes", route: "/admin/booking-requests?tab=changes", area: "admin" },
  { name: "admin-booking-requests-public", route: "/admin/booking-requests?tab=public", area: "admin" },
  { name: "admin-bookings-setup", route: "/admin/bookings-setup", area: "admin" },
  { name: "admin-booking-messages", route: "/admin/booking-messages", area: "admin" },
  { name: "admin-booking-policies", route: "/admin/booking-policies", area: "admin" },
  { name: "admin-booking-policies-cancellation", route: "/admin/booking-policies/cancellation", area: "admin" },
  { name: "admin-booking-policies-minimum-stay", route: "/admin/booking-policies/minimum-stay", area: "admin" },
  { name: "admin-booking-policies-group-discount", route: "/admin/booking-policies/group-discount", area: "admin" },
  { name: "admin-booking-policies-periods", route: "/admin/booking-policies/periods", area: "admin" },
  { name: "admin-booking-policies-public-requests", route: "/admin/booking-policies/public-requests", area: "admin" },
  { name: "admin-promo-codes", route: "/admin/promo-codes", area: "admin" },
  { name: "admin-seasons", route: "/admin/seasons", area: "admin" },
  { name: "admin-age-tier-settings", route: "/admin/age-tier-settings", area: "admin" },
  { name: "admin-payments", route: "/admin/payments", area: "admin" },
  // Batch 2 (#2050): membership & applications operator guides.
  { name: "admin-member-applications", route: "/admin/member-applications", area: "admin" },
  { name: "admin-member-fields", route: "/admin/member-fields", area: "admin" },
  { name: "admin-membership-types", route: "/admin/membership-types", area: "admin" },
  { name: "admin-membership-setup", route: "/admin/membership-setup", area: "admin" },
  { name: "admin-subscription-lockout", route: "/admin/subscription-lockout", area: "admin" },
  { name: "admin-membership-cancellations", route: "/admin/membership-cancellations", area: "admin" },
  { name: "admin-membership-cancellation", route: "/admin/membership-cancellation", area: "admin" },
  { name: "admin-committee", route: "/admin/committee", area: "admin" },
  { name: "admin-family-groups", route: "/admin/family-groups", area: "admin" },
  { name: "admin-family-suggestions", route: "/admin/family-suggestions", area: "admin" },
  { name: "admin-induction", route: "/admin/induction", area: "admin" },
  { name: "admin-induction-settings", route: "/admin/induction/settings", area: "admin" },
  { name: "admin-deletion-requests", route: "/admin/deletion-requests", area: "admin" },
  { name: "admin-lockers", route: "/admin/lockers", area: "admin" },
  { name: "admin-fees", route: "/admin/fees", area: "admin" },
  { name: "admin-subscriptions", route: "/admin/subscriptions", area: "admin" },
  { name: "admin-refund-requests", route: "/admin/refund-requests", area: "admin" },
  // The next three routes are gated by the `xeroIntegration` feature flag
  // (internet-banking additionally by `internetBankingPayments`); see
  // src/config/feature-routes.ts. They 404 (blank capture) unless those modules
  // are enabled — the default demo seed leaves Xero off, so no image is committed
  // for them and their guides describe the screens in prose. Capture these only
  // against a stack with the Xero module on.
  { name: "admin-internet-banking", route: "/admin/internet-banking", area: "admin" },
  { name: "admin-xero", route: "/admin/xero", area: "admin" },
  { name: "admin-xero-setup", route: "/admin/xero/setup", area: "admin" },
  { name: "admin-xero-member-grouping", route: "/admin/xero/member-grouping", area: "admin" },
  // Batch 4 (#2050): comms, content & support-platform operator guides.
  // Content — the Site Appearance & Content hub and its sub-pages.
  { name: "admin-appearance", route: "/admin/appearance", area: "admin" },
  { name: "admin-appearance-identity", route: "/admin/appearance/identity", area: "admin" },
  { name: "admin-site-style", route: "/admin/site-style", area: "admin" },
  { name: "admin-site-content", route: "/admin/site-content", area: "admin" },
  { name: "admin-page-content", route: "/admin/page-content", area: "admin" },
  { name: "admin-site-banners", route: "/admin/site-banners", area: "admin" },
  // mountain-conditions is gated by the `skifieldConditions` flag, which the
  // demo seed defaults ON (prisma/schema.prisma) — so it captures normally.
  { name: "admin-mountain-conditions", route: "/admin/mountain-conditions", area: "admin" },
  { name: "admin-image-manager", route: "/admin/image-manager", area: "admin" },
  // Comms — the Notifications & Email hub, its sub-pages, and deliverability.
  { name: "admin-notifications", route: "/admin/notifications", area: "admin" },
  { name: "admin-notification-rules", route: "/admin/notification-rules", area: "admin" },
  { name: "admin-notification-recipients", route: "/admin/notification-recipients", area: "admin" },
  { name: "admin-email-messages", route: "/admin/email-messages", area: "admin" },
  { name: "admin-email-deliverability", route: "/admin/email-deliverability", area: "admin" },
  // communications is gated by the `communications` flag (default ON in the seed).
  { name: "admin-communications", route: "/admin/communications", area: "admin" },
  // Support platform surfaces.
  { name: "admin-access-roles", route: "/admin/access-roles", area: "admin" },
  { name: "admin-audit-log", route: "/admin/audit-log", area: "admin" },
  { name: "admin-background-jobs", route: "/admin/background-jobs", area: "admin" },
  { name: "admin-config-transfer", route: "/admin/config-transfer", area: "admin" },
  { name: "admin-health", route: "/admin/health", area: "admin" },
  { name: "admin-issue-reports", route: "/admin/issue-reports", area: "admin" },
  { name: "admin-modules", route: "/admin/modules", area: "admin" },
  { name: "admin-security", route: "/admin/security", area: "admin" },
  { name: "admin-stuck-states", route: "/admin/stuck-states", area: "admin" },
  // integrations is gated by the `xeroIntegration` flag, which the demo seed
  // leaves OFF (schema default false) — the route 404s, so no image is
  // committed and the Integrations guide describes the screen in prose, exactly
  // like the Xero guides (batch 2). The `display` (lobby-display) hub is gated
  // by the `lobbyDisplay` flag (also OFF by default); batch 4 left it to its
  // feature hub docs, but batch 3 (below) now captures the hub + sub-pages for
  // the epic-sequenced lodge display guide, enabling the module on the capture
  // stack first.
  //
  // Batch 5 (#2050): member-facing journey guides (docs/user-guide/). These are
  // the PUBLIC and MEMBER surfaces, not /admin/*. Public pages capture without
  // auth; member pages use the seeded complete-profile member (persona:
  // "member" — WAITLISTER / Wanda, PAID + confirmed profile) so the dashboard,
  // profile, My Bookings, and booking wizard render as a real member sees them.
  // Client-side wizard/dialog sub-steps the URL-driven harness cannot reach
  // (the guests/review/pay steps, the cancellation dialog) are documented in
  // prose per the STYLE_GUIDE screenshot-density rule, so they need no capture.
  { name: "public-login", route: "/login", area: "public", auth: false },
  { name: "public-join-apply", route: "/join/apply", area: "public", auth: false },
  { name: "member-dashboard", route: "/dashboard", area: "public", persona: "member" },
  { name: "member-profile", route: "/profile", area: "public", persona: "member" },
  { name: "member-bookings", route: "/bookings", area: "public", persona: "member" },
  { name: "member-book", route: "/book", area: "public", persona: "member" },
  // Batch 3 (#2050): lodge-operations operator guides — physical-lodge day-to-day.
  // The lodge-ops sidebar section (hut leaders, roster, lodge kiosk, work parties,
  // lodge instructions), the lodge-scoped chores + rooms/beds inventory, and
  // multi-lodge management (the Lodges list). chores + roster are gated by the
  // `chores` flag, the lodge kiosk by `kiosk`, and rooms/beds by `bedAllocation` —
  // all three enabled by the E2E prepare step (e2e/setup/enable-e2e-modules.ts);
  // work-parties (`workParties`) and hut-leaders (`hutLeaders`) default ON in the
  // seed, so all seven capture normally.
  { name: "admin-chores", route: "/admin/chores", area: "admin" },
  { name: "admin-roster", route: "/admin/roster", area: "admin" },
  { name: "admin-hut-leaders", route: "/admin/hut-leaders", area: "admin" },
  { name: "admin-work-parties", route: "/admin/work-parties", area: "admin" },
  { name: "admin-lodge", route: "/admin/lodge", area: "admin" },
  { name: "admin-lodge-instructions", route: "/admin/lodge-instructions", area: "admin" },
  { name: "admin-lodges", route: "/admin/lodges", area: "admin" },
  { name: "admin-rooms-beds", route: "/admin/rooms-beds", area: "admin" },
  // Batch 3 (#2050): the Lobby Display hub and its sub-pages. Gated by the
  // `lobbyDisplay` flag, which the demo seed leaves OFF (schema default) — the
  // E2E prepare step does NOT enable it. Turn Lobby Display ON via Admin → Setup
  // → Modules on the ephemeral capture stack (only) before capturing these, as
  // the display guide documents.
  //
  // The committed images were re-captured at batch-3 finalisation against a
  // capture stack rebuilt from this branch (which carries #2047 + #2048):
  //   - `admin-display` (the hub) shows the FIVE-card hub — Devices, **Visual
  //     builder** (#2048), Layouts (Advanced), Templates, and Reference — matching
  //     the five-card hub the display guide documents.
  //   - `admin-display-templates` shows the FULL SEVEN built-ins from the #2047
  //     template pack: Everyday board, Whole lodge, Singles house, Room by room,
  //     Nights ahead, Lodge operations, and Welcome kiosk (each with a Builder
  //     entry into the #2048 visual builder).
  // The visual builder page itself ships its own docs and is not part of this
  // batch-3 manifest.
  { name: "admin-display", route: "/admin/display", area: "admin" },
  { name: "admin-display-devices", route: "/admin/display/devices", area: "admin" },
  { name: "admin-display-layouts", route: "/admin/display/layouts", area: "admin" },
  { name: "admin-display-templates", route: "/admin/display/templates", area: "admin" },
  { name: "admin-display-reference", route: "/admin/display/reference", area: "admin" },
  { name: "admin-display-preview", route: "/admin/display/preview", area: "admin" },
];

const VIEWPORT = { width: 1280, height: 800 } as const;

// The floating "Report issue" widget (src/components/report-issue-widget.tsx)
// is a fixed-position bug button + dialog that can overlap stat cards and tables
// in a full-page capture. It is not part of any documented feature, so we hide
// every element it tags with `data-report-issue-ignore` before shooting. This is
// a deliberate, documented harness step (#2050) — not a per-guide hack — so every
// operator screenshot is free of the widget without touching runtime app code.
const HIDE_OVERLAYS_CSS =
  '[data-report-issue-ignore="true"] { display: none !important; }';
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
    // Authenticated pages gate edit affordances on the CLIENT session hook
    // (useAdminAreaEditAccess -> useSession), which reports view-only until the
    // post-hydration /api/auth/session fetch resolves. A shot taken in that
    // window captures a false "view only" banner with disabled controls
    // (#2050 batch-1 review finding on admin-book). Arm the waiter BEFORE
    // navigation so the response cannot slip past us, and bound it so an
    // unauthenticated page (which never fetches the session) cannot stall.
    const sessionSettled =
      capture.auth === false
        ? Promise.resolve()
        : page
            .waitForResponse((r) => r.url().includes("/api/auth/session"), { timeout: 10_000 })
            .then(() => undefined)
            .catch(() => undefined);
    // Wait for the document 'load' event (deterministic), not "networkidle":
    // networkidle can hang or resolve arbitrarily on pages with long-poll /
    // streaming / analytics requests. Give it an explicit navigation timeout.
    await page.goto(new URL(capture.route, BASE_URL).toString(), { waitUntil: "load", timeout: 30_000 });
    await sessionSettled;
    // Settle: let web fonts finish so text is not captured in a fallback face,
    // bounded by an explicit timeout so a stuck font load cannot block a shot.
    await Promise.race([
      page.evaluate(() => document.fonts.ready.then(() => undefined)),
      page.waitForTimeout(3_000),
    ]);
    if (capture.waitForText) {
      await page.getByText(capture.waitForText).first().waitFor({ state: "visible", timeout: 15_000 });
    }
    // Many admin pages render their content in a client component that fetches
    // after hydration, showing a "Loading…" sentinel until the data arrives.
    // The 'load' event fires before that fetch resolves, so a naive shot would
    // capture the spinner. Wait for every "Loading" sentinel to disappear (a
    // detached/hidden element counts as satisfied immediately, so pages that
    // never show one are unaffected), then let the loaded content paint. The
    // .catch keeps a genuinely stuck page from aborting the whole run.
    await page
      .locator("text=/Loading/i")
      .first()
      .waitFor({ state: "hidden", timeout: 15_000 })
      .catch(() => undefined);
    await page.waitForTimeout(800);
    // Hide the floating "Report issue" widget so it never overlaps captured
    // content (see HIDE_OVERLAYS_CSS). addStyleTag injects into the live page
    // just before the shot; it does not modify the app source.
    await page.addStyleTag({ content: HIDE_OVERLAYS_CSS });
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
    const adminNeeded = captures.some((c) => c.auth !== false && c.persona !== "member");
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

    // Member session (batch 5): the seeded complete-profile member. Reuse a
    // stored state if the E2E suite already logged Wanda in, otherwise sign her
    // in through the same loginPersona path the admin context uses (it clears
    // whatever two-factor step the server demands). No forced password change
    // or profile gate blocks her, so she lands straight on the member surface.
    const memberNeeded = captures.some((c) => c.auth !== false && c.persona === "member");
    let memberContext: BrowserContext | undefined;
    if (memberNeeded) {
      const statePath = storageStatePath(WAITLISTER.email);
      if (fs.existsSync(statePath)) {
        memberContext = await browser.newContext({ baseURL: BASE_URL, viewport: VIEWPORT, storageState: statePath });
      } else {
        const bootstrap = await browser.newContext({ baseURL: BASE_URL, viewport: VIEWPORT });
        const page = await bootstrap.newPage();
        await page.goto(new URL("/login", BASE_URL).toString());
        await loginPersona(page, WAITLISTER.email);
        await bootstrap.storageState({ path: statePath });
        await bootstrap.close();
        memberContext = await browser.newContext({ baseURL: BASE_URL, viewport: VIEWPORT, storageState: statePath });
      }
    }

    const publicContext = await browser.newContext({ baseURL: BASE_URL, viewport: VIEWPORT });

    for (const capture of captures) {
      let ctx: BrowserContext | undefined;
      if (capture.auth === false) ctx = publicContext;
      else if (capture.persona === "member") ctx = memberContext;
      else ctx = adminContext;
      if (!ctx) throw new Error(`No ${capture.persona ?? "admin"} context available for capture "${capture.name}"`);
      await shoot(ctx, capture);
    }

    await publicContext.close();
    await memberContext?.close();
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
