import { defineConfig, devices } from "@playwright/test";

// Browser E2E suite for the Critical journeys in docs/END_TO_END_TEST_MATRIX.md.
// It drives the staging Docker Compose stack (docker-compose.staging.yml) seeded
// with prisma/seed.ts + prisma/demo-seed.ts. Run via `npm run test:e2e`, which
// prepares the stack and database first; see docs/E2E_PLAYWRIGHT.md.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3001";

// Multi-lodge coverage (issue #1568; a blocking CI check since #1655) runs as
// a separate opt-in project, seeded with a second active lodge
// (E2E_MULTI_LODGE=1 → e2e/setup/seed-second-lodge.ts). Its specs live under
// e2e/multi-lodge/ and are ALWAYS excluded from the default chromium project
// (testIgnore below), so the default single-lodge suite never runs them. The
// project itself is only added to the config when E2E_MULTI_LODGE is set, so
// the default suite's project list is byte-identical.
const multiLodgeEnabled = process.env.E2E_MULTI_LODGE === "1";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  // Specs share seeded personas and assert on lodge capacity, so they must not
  // interleave. One worker keeps every capacity/conflict assertion deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // Retry twice in CI. The server-side keepAliveTimeout raise
  // (KEEP_ALIVE_TIMEOUT=65000 in docker-compose.staging.yml) removes the
  // keep-alive socket-reset race at its source; retries are the pragmatic
  // backstop for any residual transport-level `socket hang up` on a pooled
  // API request. Kept at 0 locally so a real failure surfaces immediately.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // Signs in the booking persona once (completing TOTP enrollment on a fresh
    // database) and saves storage state for the booking/payment specs.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      // The multi-lodge specs need a two-lodge database; keep them out of the
      // default single-lodge project (they only run in the `multi-lodge`
      // project below). Byte-identical for the default suite: this dir is
      // otherwise empty, so the matched spec set is unchanged.
      testIgnore: /multi-lodge\//,
    },
    // Cross-lodge isolation project — issue #1568, blocking in CI since #1655.
    // Only present when E2E_MULTI_LODGE=1, so the default project list is unchanged.
    // Each spec logs in for itself (like waitlist.spec), so no setup dependency.
    ...(multiLodgeEnabled
      ? [
          {
            name: "multi-lodge",
            testMatch: /multi-lodge\/.*\.spec\.ts/,
            use: { ...devices["Desktop Chrome"] },
          },
        ]
      : []),
  ],
});
