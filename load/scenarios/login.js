/**
 * Scenario: login (authenticated session establishment) — issue #1884.
 *
 * VUs ramp to PEAK_VUS (default 100), and every iteration performs a full
 * cold login: clear cookies, fetch the Auth.js CSRF token, POST the
 * credentials callback, verify a session cookie landed. bcrypt verification
 * makes this the most CPU-expensive request in the app, so its p95 gets its
 * own (higher) budget via LOGIN_P95_MS.
 *
 * Each iteration uses a distinct synthetic X-Forwarded-For (the same trick
 * as the Playwright e2e suite) so the 10-per-15-min per-IP login limiter
 * measures the app, not the limiter. That spoof only works on the proxyless
 * throwaway stack.
 *
 * Run (throwaway local stack ONLY — see docs/LOAD_TESTING.md):
 *   BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
 *     LOAD_USER_EMAIL=alice@demo.alpineclub.test LOAD_USER_PASSWORD=... \
 *     k6 run load/scenarios/login.js
 */

import http from "k6/http";
import { sleep } from "k6";
import { Rate } from "k6/metrics";
import { assertSafeTarget } from "../lib/target-guard.js";
import {
  loadConfig,
  requireCredentials,
  rampStages,
} from "../lib/config.js";
import { login, clearSession } from "../lib/session.js";

const cfg = loadConfig(__ENV); // init-context guard: aborts unsafe targets
requireCredentials(cfg);

const loginP95Ms = parseInt(__ENV.LOGIN_P95_MS || "2000", 10);
const loginSuccess = new Rate("login_success");

export const options = {
  scenarios: {
    login: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: rampStages(cfg),
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    "http_req_duration{flow:login}": ["p(95)<" + loginP95Ms],
    http_req_failed: ["rate<" + cfg.maxErrorRate],
    login_success: ["rate>" + (1 - cfg.maxErrorRate)],
  },
};

export function setup() {
  assertSafeTarget(__ENV); // belt-and-braces re-check
  const probe = http.get(cfg.baseUrl + "/login");
  if (probe.status !== 200) {
    throw new Error(
      "Target probe failed: GET " +
        cfg.baseUrl +
        "/login returned " +
        probe.status
    );
  }
}

export default function loginFlow() {
  clearSession(cfg); // every iteration is a cold login
  const ok = login(cfg, cfg.userEmail, cfg.userPassword, __ITER);
  loginSuccess.add(ok);
  sleep(cfg.thinkTime);
}
