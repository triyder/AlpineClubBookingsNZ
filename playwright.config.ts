import { defineConfig, devices } from "@playwright/test";

// Browser E2E suite for the Critical journeys in docs/END_TO_END_TEST_MATRIX.md.
// It drives the staging Docker Compose stack (docker-compose.staging.yml) seeded
// with prisma/seed.ts + prisma/demo-seed.ts. Run via `npm run test:e2e`, which
// prepares the stack and database first; see docs/E2E_PLAYWRIGHT.md.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3001";

// Advisory multi-lodge coverage (issue #1568) runs as a separate opt-in
// project, seeded with a second active lodge (E2E_MULTI_LODGE=1 →
// e2e/setup/seed-second-lodge.ts). Its specs live under e2e/multi-lodge/ and
// are ALWAYS excluded from the default chromium project (testIgnore below), so
// the blocking single-lodge suite never runs them. The project itself is only
// added to the config when E2E_MULTI_LODGE is set, so the default suite's
// project list is byte-identical.
const multiLodgeEnabled = process.env.E2E_MULTI_LODGE === "1";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  // Specs share seeded personas and assert on lodge capacity, so they must not
  // interleave. One worker keeps every capacity/conflict assertion deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
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
      // The advisory multi-lodge specs need a two-lodge database; keep them out
      // of the default single-lodge project (they only run in the `multi-lodge`
      // project below). Byte-identical for the blocking suite: this dir is
      // otherwise empty, so the matched spec set is unchanged.
      testIgnore: /multi-lodge\//,
    },
    // Advisory (non-blocking) cross-lodge isolation project — issue #1568. Only
    // present when E2E_MULTI_LODGE=1, so the default project list is unchanged.
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
