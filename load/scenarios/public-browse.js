/**
 * Scenario: public browse (unauthenticated) — issue #1884.
 *
 * Anonymous visitors ramp to PEAK_VUS (default 100) and walk the public
 * marketing/auth pages: landing, join, contact, login. There is no public
 * availability endpoint in this app (availability is auth-gated), so this
 * scenario also probes `GET /api/availability` unauthenticated and asserts
 * the cheap 401 — that keeps the public-facing surface of the availability
 * route under load without a session. The authenticated availability read
 * path is exercised by member-dashboard.js.
 *
 * Run (throwaway local stack ONLY — see docs/LOAD_TESTING.md):
 *   BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
 *     k6 run load/scenarios/public-browse.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { assertSafeTarget } from "../lib/target-guard.js";
import { loadConfig, rampStages, standardThresholds } from "../lib/config.js";
import { vuHeaders } from "../lib/session.js";

const cfg = loadConfig(__ENV); // init-context guard: aborts unsafe targets

export const options = {
  scenarios: {
    public_browse: {
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

const PUBLIC_PAGES = ["/", "/join", "/contact", "/login"];

export default function publicBrowse() {
  const headers = vuHeaders(0);

  for (const path of PUBLIC_PAGES) {
    const res = http.get(cfg.baseUrl + path, {
      headers: headers,
      tags: { flow: "public_browse", page: path },
    });
    check(res, {
      "public page 200": function (r) {
        return r.status === 200;
      },
    });
    sleep(cfg.thinkTime);
  }

  // Availability read path, unauthenticated: must be a fast, clean 401.
  // expectedStatuses stops the 401 from counting toward http_req_failed.
  const availability = http.get(
    cfg.baseUrl + "/api/availability?year=2026&month=7",
    {
      headers: headers,
      tags: { flow: "public_browse", page: "/api/availability" },
      responseCallback: http.expectedStatuses(401),
    }
  );
  check(availability, {
    "unauthenticated availability returns 401": function (r) {
      return r.status === 401;
    },
  });
  sleep(cfg.thinkTime);
}
