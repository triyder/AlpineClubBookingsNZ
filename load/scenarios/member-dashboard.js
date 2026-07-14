/**
 * Scenario: member dashboard + availability reads (authenticated) — #1884.
 *
 * Each VU logs in once (session cookie is reused across iterations), then
 * loops the authenticated read paths a member hits while planning a stay:
 *   GET /dashboard                      server-rendered member landing page
 *   GET /api/lodges                     lodges this member may book
 *   GET /api/availability?year&month    calendar occupancy (month 0-indexed)
 *   GET /api/member/credit-balance      credit widget JSON
 *
 * The availability endpoints share a 60-per-minute per-IP limiter; each VU
 * presents its own synthetic client IP and default think time keeps one VU
 * well under that budget, so the run measures the app rather than the
 * limiter.
 *
 * Run (throwaway local stack ONLY — see docs/LOAD_TESTING.md):
 *   BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
 *     LOAD_USER_EMAIL=alice@demo.alpineclub.test LOAD_USER_PASSWORD=... \
 *     k6 run load/scenarios/member-dashboard.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { assertSafeTarget } from "../lib/target-guard.js";
import {
  loadConfig,
  requireCredentials,
  rampStages,
  standardThresholds,
} from "../lib/config.js";
import { ensureLoggedIn, vuHeaders } from "../lib/session.js";

const cfg = loadConfig(__ENV); // init-context guard: aborts unsafe targets
requireCredentials(cfg);

export const options = {
  scenarios: {
    member_dashboard: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: rampStages(cfg),
      gracefulRampDown: "10s",
    },
  },
  thresholds: standardThresholds(cfg),
};

export function setup() {
  assertSafeTarget(__ENV); // belt-and-braces re-check
  const probe = http.get(cfg.baseUrl + "/");
  if (probe.status !== 200) {
    throw new Error(
      "Target probe failed: GET " + cfg.baseUrl + "/ returned " + probe.status
    );
  }
}

// Per-VU login memo (init context runs once per VU).
const vuState = { loggedIn: false };

// Availability month to read: the contention check-in month, so a mixed
// run reads the same calendar the write path is contending on.
const availYear = parseInt(cfg.contentionCheckIn.slice(0, 4), 10);
const availMonth = parseInt(cfg.contentionCheckIn.slice(5, 7), 10) - 1; // 0-indexed

export default function memberDashboard() {
  if (!ensureLoggedIn(cfg, cfg.userEmail, cfg.userPassword, vuState)) {
    sleep(cfg.thinkTime);
    return;
  }
  const headers = vuHeaders(0);
  const tags = { flow: "member_dashboard" };

  const dashboard = http.get(cfg.baseUrl + "/dashboard", {
    headers: headers,
    tags: tags,
  });
  check(dashboard, {
    "dashboard 200": function (r) {
      return r.status === 200;
    },
  });
  sleep(cfg.thinkTime);

  const lodges = http.get(cfg.baseUrl + "/api/lodges", {
    headers: headers,
    tags: tags,
  });
  check(lodges, {
    "lodges 200 with list": function (r) {
      if (r.status !== 200) return false;
      try {
        return Array.isArray(r.json("lodges"));
      } catch {
        return false;
      }
    },
  });
  sleep(cfg.thinkTime);

  const availability = http.get(
    cfg.baseUrl +
      "/api/availability?year=" +
      availYear +
      "&month=" +
      availMonth +
      (cfg.lodgeId ? "&lodgeId=" + cfg.lodgeId : ""),
    { headers: headers, tags: tags }
  );
  check(availability, {
    "availability 200 with calendar": function (r) {
      if (r.status !== 200) return false;
      try {
        return r.json("availability") !== undefined;
      } catch {
        return false;
      }
    },
  });
  sleep(cfg.thinkTime);

  const credit = http.get(cfg.baseUrl + "/api/member/credit-balance", {
    headers: headers,
    tags: tags,
  });
  check(credit, {
    "credit balance 200": function (r) {
      return r.status === 200;
    },
  });
  sleep(cfg.thinkTime);
}
