# Load Testing (k6 harness)

This is the evidence framework for the production-hardening target of
"stable at 100+ concurrent users" (issue #1884). It drives the app **over
HTTP only** with [k6](https://k6.io) scripts that live in
[`load/`](../load/). Each scenario ramps to a configurable peak (default
100 VUs) and has k6 `thresholds`, so every run has explicit pass/fail
criteria instead of vibes.

## Safety rules — read before anything else

Quoted from [`AGENTS.md`](../AGENTS.md) → Safety Rules, which govern this
harness exactly as they govern every other tool in the repo:

> - Do not use production credentials, production databases, production
>   backups, live Stripe, live Xero, live SES, live Sentry, or live provider
>   webhooks for exploratory work.
> - Do not run browser automation, DAST, load tests, or broad endpoint
>   scanning against a live deployment without a written test window.

In concrete terms for this harness:

- **No live targets.** Only the throwaway local staging compose stack (or an
  equally disposable local dev server). Never a deployed instance, never
  `tokoroa.org.nz` or any club fork's domain.
- **Throwaway database only.** A load run creates real bookings and real
  sessions on whatever it hits. The staging stack's Postgres (host port
  5433) is reset and reseeded by the e2e scripts and is the only acceptable
  datastore behind a target.
- **Never `:5432`.** On club deployment hosts (and at least one developer
  machine) port 5432 is the **live production Postgres**. The harness never
  speaks to a database at all — HTTP to the app only — and its target guard
  hard-refuses any `BASE_URL` mentioning `:5432`.
- **No live providers.** The scenarios only create PENDING bookings with the
  default payment method and never call the payment-confirmation, email, or
  Xero endpoints, so no Stripe/Xero/SES traffic is ever generated. The
  staging stack additionally runs with `CRON_ENABLED=false` and captures all
  mail in Mailpit.
- A full 100-VU run is **owner-gated**: agents build and syntax-check this
  harness but do not execute load runs autonomously.

### The pre-flight target guard

Every scenario imports [`load/lib/target-guard.js`](../load/lib/target-guard.js)
in k6's init context (and re-asserts it in `setup()`), so a run aborts
before the first VU starts unless **all** of the following hold:

1. `BASE_URL` is set explicitly — there is no default target.
2. `LOAD_TEST_CONFIRM_TARGET=1` is set — a deliberate, per-run opt-in.
3. `BASE_URL` contains no `:5432` anywhere (string check *and* parsed-port
   check, so a pasted database URL is refused too).
4. The hostname is **not** `tokoroa.org.nz` or any subdomain, contains no
   `prod`, and **is** on the local allowlist: `localhost`, `127.0.0.1`,
   `::1`, `host.docker.internal`, or a `*.localhost` / `*.test` name.

There is no override switch. If you believe you need to load test something
the guard refuses, that is an owner conversation and a written test window,
not a code edit.

## Standing up the throwaway target stack

The same staging compose stack the Playwright e2e suite uses (see
[`E2E_PLAYWRIGHT.md`](E2E_PLAYWRIGHT.md)):

```bash
cp .env.staging.example .env.staging   # first time only
npm run test:e2e:prepare               # up + migrate + demo-seed the stack
```

That publishes the app at **`http://localhost:3001`**, Postgres at
`127.0.0.1:5433` (never 5432), and Mailpit at `127.0.0.1:8025`. Tear it all
down afterwards with `npm run test:e2e:down` (removes the volume — the
bookings a load run created go with it).

The demo seed provides the test accounts. All demo personas share the
seeded demo password (`DEMO_SEED_PASSWORD`, default documented in
`prisma/demo-seed.ts` / `.env.staging.example`); the natural load persona is
`alice@demo.alpineclub.test`, a paid-up member who can book at member rates.
Credentials are passed to k6 via env only — the scripts refuse to run an
authenticated scenario without `LOAD_USER_PASSWORD`.

k6 itself is a single binary: <https://k6.io/docs/get-started/installation/>.
It is deliberately **not** an npm dependency and never runs in CI.

## Environment variables

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `BASE_URL` | **yes** | — | Target origin, e.g. `http://localhost:3001`. Must pass the guard. |
| `LOAD_TEST_CONFIRM_TARGET` | **yes** | — | Must be exactly `1`. The per-run "I checked the target" opt-in. |
| `LOAD_USER_EMAIL` | for auth scenarios | `alice@demo.alpineclub.test` | Member to log in as. |
| `LOAD_USER_PASSWORD` | for auth scenarios | — | That member's password (the staging demo-seed password). Never hardcoded. |
| `LOAD_USERS` | no | — | Comma-separated extra member emails (same password) so contention VUs spread across accounts. |
| `PEAK_VUS` | no | `100` | Peak virtual users for the ramp / contention stampede. |
| `RAMP_UP` / `STEADY` / `RAMP_DOWN` | no | `1m` / `3m` / `30s` | Stage durations for the ramping scenarios. |
| `P95_MS` | no | `800` | p95 latency budget (ms) for the read scenarios. |
| `LOGIN_P95_MS` | no | `2000` | p95 budget for the bcrypt-heavy login flow. |
| `MAX_ERROR_RATE` | no | `0.01` | Failure-rate threshold shared by all scenarios. |
| `THINK_TIME` | no | `1` | Seconds of sleep between requests in an iteration. |
| `LODGE_ID` | no | — | Lodge to book/read; empty lets the app resolve the default lodge. |
| `CONTENTION_CHECKIN` | no | `2026-08-18` | The single night everyone fights over. Must be a bookable (in-season, future) date on the seeded stack. |
| `CONTENTION_CHECKOUT` | no | check-in + 1 day | Override only for multi-night contention. |
| `CONTENTION_ATTEMPTS` | no | `3` | Booking attempts per VU (keeps each synthetic IP under the 20/hour booking-create limit). |
| `CONTENTION_P95_MS` | no | `5000` | p95 budget for the serialised booking write. |

## Scenarios

All four live in `load/scenarios/` and share `load/lib/` (guard, config,
login helper). Convenience wrappers exist in `package.json` (`npm run
load:public` etc.) — they only pass through to `k6 run` and abort on the
guard unless the env above is set.

### 1. Public browse — `load/scenarios/public-browse.js`

Anonymous VUs ramp to `PEAK_VUS` walking `/`, `/join`, `/contact`,
`/login`, asserting 200s. There is **no public availability endpoint** in
this app (availability is auth-gated), so the scenario also probes
`GET /api/availability` unauthenticated and asserts the cheap `401` — the
authenticated availability read lives in the dashboard scenario instead.

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  k6 run load/scenarios/public-browse.js
```

### 2. Login — `load/scenarios/login.js`

Every iteration is a full cold login: clear cookies →
`GET /api/auth/csrf` → form-`POST /api/auth/callback/credentials` → assert
a session cookie landed. bcrypt makes this the most CPU-expensive request
in the app, hence its own `LOGIN_P95_MS` budget and the `login_success`
rate threshold.

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> \
  k6 run load/scenarios/login.js
```

### 3. Booking-hold contention — `load/scenarios/booking-contention.js`

**The core scaling evidence.** `PEAK_VUS` members stampede
`POST /api/bookings` for **one lodge + one night**
(`CONTENTION_CHECKIN`), which serialises on the per-lodge advisory lock
(`pg_advisory_xact_lock(hashtextextended(lodgeId, 0))` — see
[`CONCURRENCY_AND_LOCKING.md`](CONCURRENCY_AND_LOCKING.md) and
[`CAPACITY_MODEL.md`](CAPACITY_MODEL.md)). Race losers block on the lock,
re-check capacity, and receive the app's normal sold-out answer, so the
scenario asserts on the **outcome distribution**, not just 200s:

- `201` → counted as `bookings_created` (race winners);
- `409` + `code: "CAPACITY_EXCEEDED"` (with `canWaitlist: true` and a
  `fullNights` array) → counted as `booking_capacity_rejections` — this is
  a *pass*, it is the correct answer for a full lodge;
- `409` + `code: "BOOKING_MEMBER_NIGHT_CONFLICT"` → counted separately
  (can occur when `LOAD_USERS` members already sit on that night);
- anything else (5xx, timeout, other 4xx) trips the `booking_unexpected`
  threshold and fails the run.

Latency gets a deliberately loose `CONTENTION_P95_MS` (default 5 s) because
the lock serialises writers **by design**; the run fails on errors, not on
queueing. After the run, verify the capacity invariant manually:
`bookings_created` must not exceed the lodge's bed count for that night
(default seed lodge: 20 beds).

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> CONTENTION_CHECKIN=2026-08-18 \
  k6 run load/scenarios/booking-contention.js
```

Bookings are created with non-member guests and the default payment method,
which records a PENDING booking and **touches no payment provider**. Reset
the stack (`npm run test:e2e:down && npm run test:e2e:prepare`) between
contention runs so each run starts from a known-empty night.

### 4. Member dashboard — `load/scenarios/member-dashboard.js`

Each VU logs in once, then loops the authenticated read paths:
`/dashboard` (server-rendered), `/api/lodges`, `/api/availability`
(the calendar month containing `CONTENTION_CHECKIN`, so a side-by-side run
reads the calendar the write path is contending on), and
`/api/member/credit-balance`.

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> \
  k6 run load/scenarios/member-dashboard.js
```

## Reading the output

k6 prints a summary at the end of each run; the run **exits non-zero if any
threshold fails**, which is the pass/fail signal:

- `http_req_duration … p(95)` vs the scenario's budget (`P95_MS`,
  `LOGIN_P95_MS`, `CONTENTION_P95_MS`). Login and booking flows are also
  tagged (`{flow:login}`, `{flow:booking_contention}`) so their thresholds
  are scoped to the flow, not diluted by cheap requests.
- `http_req_failed` — transport/5xx failure rate vs `MAX_ERROR_RATE`.
  Expected non-2xx outcomes (the public 401 probe, the contention 409s) are
  registered via `expectedStatuses` so they do **not** count here.
- `checks` / `login_success` / `booking_unexpected` — semantic assertions
  (right status *and* right body shape).
- Contention counters: `bookings_created`, `booking_capacity_rejections`,
  `booking_member_night_conflicts`. Healthy 100-VU run against a fresh
  20-bed night: created ≈ 20, capacity rejections ≈ the rest, unexpected 0,
  and created **never** above the bed count.

A smoke-scale sanity pass (recommended before any full run):

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> \
  PEAK_VUS=5 RAMP_UP=10s STEADY=30s RAMP_DOWN=5s \
  k6 run load/scenarios/public-browse.js
```

## Implementation notes

- **Rate limiters vs load:** the app keys its per-IP limiters on the last
  entry of `X-Forwarded-For` (production Caddy appends the real client IP).
  The proxyless staging stack trusts the header as sent, so — like the
  Playwright helpers — each VU presents a unique synthetic `10.99.x.x`
  address. Login rotates the address per iteration (limit 10/15 min);
  contention keeps one address per VU and stays under the 20/hour
  booking-create limit via `CONTENTION_ATTEMPTS`. This is a test-stack
  convenience, not a production bypass: behind Caddy the trusted last hop
  is always the real IP.
- **Auth:** NextAuth v5 credentials flow; the session cookie
  (`authjs.session-token`) lives in k6's per-VU cookie jar. The app's own
  JSON APIs authorise on that cookie alone (no per-request CSRF token), so
  `POST /api/bookings` needs no extra token. Keep the staging two-factor
  module disabled for load personas (the default seed state) or logins will
  park at `/login/verify`.
- k6 scripts are ES modules executed by k6's own runtime — they are not part
  of the app bundle, `npm test`, or CI, and `k6` is not a dependency.
