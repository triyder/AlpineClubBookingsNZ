/**
 * Scenario: booking-hold contention on ONE lodge + ONE night — issue #1884.
 *
 * The core scaling concern: every booking write serialises on the per-lodge
 * Postgres advisory lock (`pg_advisory_xact_lock(hashtextextended(lodgeId,0))`,
 * src/lib/capacity.ts — see docs/CONCURRENCY_AND_LOCKING.md). This scenario
 * stampedes PEAK_VUS members (default 100) at `POST /api/bookings` for the
 * same lodge and the same night. Losers of the race do NOT error out early:
 * they block on the lock, re-check capacity, and get the app's normal
 * sold-out answer. So the assertions accept exactly two outcomes:
 *
 *   201                          booking created (a winner)
 *   409 code=CAPACITY_EXCEEDED   lodge full / lost the race (a normal loser)
 *
 * Anything else (5xx, timeouts, 4xx other than the capacity 409) counts
 * against the `booking_unexpected` threshold and fails the run. Latency gets
 * a deliberately loose p95 (CONTENTION_P95_MS, default 5000ms) because the
 * advisory lock serialises writers by design; what must NOT happen is
 * errors or unbounded queueing.
 *
 * After the run, verify the capacity invariant by eye: `bookings_created`
 * must not exceed the lodge's bed count for that night (default seed: 20).
 *
 * Bookings are created with non-member guests and the default payment
 * method, which only records a PENDING booking — no Stripe/Xero/SES call is
 * ever made by this scenario. Each VU makes CONTENTION_ATTEMPTS (default 3)
 * attempts, staying under the 20-per-hour per-IP booking-create limiter.
 *
 * Run (throwaway local stack ONLY — see docs/LOAD_TESTING.md):
 *   BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
 *     LOAD_USER_EMAIL=alice@demo.alpineclub.test LOAD_USER_PASSWORD=... \
 *     CONTENTION_CHECKIN=2026-08-18 \
 *     k6 run load/scenarios/booking-contention.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";
import exec from "k6/execution";
import { assertSafeTarget } from "../lib/target-guard.js";
import { loadConfig, requireCredentials } from "../lib/config.js";
import { ensureLoggedIn, vuHeaders } from "../lib/session.js";

const cfg = loadConfig(__ENV); // init-context guard: aborts unsafe targets
requireCredentials(cfg);

// 201 = won the race; 409 = the app's normal "sold out / lost the race"
// answer. Neither should count toward http_req_failed in this scenario.
http.setResponseCallback(http.expectedStatuses(200, 201, 302, 409));

const bookingsCreated = new Counter("bookings_created");
const capacityRejections = new Counter("booking_capacity_rejections");
const nightConflicts = new Counter("booking_member_night_conflicts");
const unexpected = new Rate("booking_unexpected");

function addOneDay(dateOnly) {
  const t = Date.parse(dateOnly + "T00:00:00Z") + 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

const checkIn = cfg.contentionCheckIn;
const checkOut = cfg.contentionCheckOut || addOneDay(checkIn);

export const options = {
  scenarios: {
    booking_contention: {
      executor: "per-vu-iterations",
      vus: cfg.peakVus,
      iterations: cfg.contentionAttempts,
      maxDuration: "10m",
    },
  },
  thresholds: {
    // The advisory lock serialises writers; latency may be high but the
    // outcome distribution must stay clean.
    "http_req_duration{flow:booking_contention}": [
      "p(95)<" + cfg.contentionP95Ms,
    ],
    booking_unexpected: ["rate<" + cfg.maxErrorRate],
    http_req_failed: ["rate<" + cfg.maxErrorRate],
  },
};

export function setup() {
  assertSafeTarget(__ENV); // belt-and-braces re-check
  const probe = http.get(cfg.baseUrl + "/", {
    responseCallback: http.expectedStatuses(200),
  });
  if (probe.status !== 200) {
    throw new Error(
      "Target probe failed: GET " + cfg.baseUrl + "/ returned " + probe.status
    );
  }
}

// Per-VU login memo. VUs round-robin across the optional LOAD_USERS pool so
// runs can spread load over several seeded members; all share LOAD_USER_PASSWORD.
const vuState = { loggedIn: false };

function vuEmail() {
  const pool = [cfg.userEmail].concat(cfg.userPool);
  return pool[(exec.vu.idInTest - 1) % pool.length];
}

export default function bookingContention() {
  if (!ensureLoggedIn(cfg, vuEmail(), cfg.userPassword, vuState)) {
    unexpected.add(true);
    return;
  }

  const vuId = exec.vu.idInTest;
  const body = {
    checkIn: checkIn,
    checkOut: checkOut,
    guests: [
      {
        firstName: "LoadTest",
        lastName: "VU" + vuId + "I" + __ITER,
        ageTier: "ADULT",
        isMember: false,
      },
    ],
    notes: "k6 load harness #1884 — throwaway stack only",
  };
  if (cfg.lodgeId) {
    body.lodgeId = cfg.lodgeId;
  }

  const res = http.post(cfg.baseUrl + "/api/bookings", JSON.stringify(body), {
    headers: Object.assign(
      { "Content-Type": "application/json" },
      vuHeaders(0)
    ),
    tags: { flow: "booking_contention" },
    timeout: "60s",
  });

  let code = "";
  try {
    code = res.json("code") || "";
  } catch {
    code = "";
  }

  const created = res.status === 201;
  const lostRace = res.status === 409 && code === "CAPACITY_EXCEEDED";
  const nightConflict =
    res.status === 409 && code === "BOOKING_MEMBER_NIGHT_CONFLICT";

  if (created) bookingsCreated.add(1);
  if (lostRace) capacityRejections.add(1);
  if (nightConflict) nightConflicts.add(1);
  unexpected.add(!(created || lostRace || nightConflict));

  check(res, {
    "booking created (201) or clean capacity 409": function () {
      return created || lostRace || nightConflict;
    },
    "capacity 409 carries the standard body": function (r) {
      if (r.status !== 409 || code !== "CAPACITY_EXCEEDED") return true;
      try {
        return (
          r.json("canWaitlist") === true &&
          Array.isArray(r.json("fullNights"))
        );
      } catch {
        return false;
      }
    },
  });

  sleep(cfg.thinkTime);
}
