# k6 load-test harness

Evidence framework for "stable at 100+ concurrent users" (issue #1884).
**Full guide: [`docs/LOAD_TESTING.md`](../docs/LOAD_TESTING.md).**

> **SAFETY — the AGENTS.md rules apply here with no exceptions:**
> no live targets (never `tokoroa.org.nz` or any deployed instance),
> throwaway database only (the staging stack's Postgres on host port 5433),
> and **never anything on `:5432` — that is live production Postgres**.
> Load tests against a live deployment require a written test window.

Layout:

- `lib/target-guard.js` — pre-flight guard; every run aborts unless
  `BASE_URL` is an allowlisted local target **and**
  `LOAD_TEST_CONFIRM_TARGET=1` is set. No override exists.
- `lib/config.js` / `lib/session.js` — shared env config and the NextAuth
  credentials login helper.
- `scenarios/public-browse.js` — anonymous page walk + unauthenticated
  availability probe (asserts 401).
- `scenarios/login.js` — full cold-login flow per iteration.
- `scenarios/booking-contention.js` — PEAK_VUS members stampede one lodge +
  one night through the per-lodge advisory lock; asserts 201s and clean
  `409 CAPACITY_EXCEEDED` losses only.
- `scenarios/member-dashboard.js` — authenticated dashboard, lodges,
  availability, and credit-balance reads.

Quick start against the throwaway staging stack:

```bash
npm run test:e2e:prepare   # app on http://localhost:3001, Postgres on 5433
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> \
  PEAK_VUS=5 RAMP_UP=10s STEADY=30s k6 run load/scenarios/public-browse.js
npm run test:e2e:down      # tear down, discarding load-created bookings
```
