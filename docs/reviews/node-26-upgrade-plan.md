# Node 26 LTS + `@types/node` 26 Upgrade — Plan (issue #1176)

Date: 2026-07-07. Planning-only deliverable. **This issue is GATED.** Per
Decision-menu **D5** (owner-ratified 2026-07-04), the Node 26 LTS runtime and
`@types/node` 26 are a **coupled major upgrade** that ships together in its own
maintenance window. No pre-authorization applies: **nothing in the change-set
below proceeds without an owner GO comment on #1176.** This PR adds only this
document — it bumps no dependency and edits no `package.json`,
`package-lock.json`, Dockerfile, compose file, CI workflow, or `engines`.

Web facts were gathered on the access date above; every external claim is cited
in [Sources](#sources).

## Executive summary — recommendation

**Do not upgrade now. Schedule the coupled bump for shortly after Node 26 reaches
Active LTS (October 2026), once the compatibility matrix below is all-green.**

- As of the access date, **Node 26 is the "Current" line, not yet LTS** — it was
  released 2026-05-05 and enters **Active LTS in October 2026** [S1][S2]. Two of
  the repo's load-bearing dependencies (Prisma, Next.js) document support only
  through Node 24 today and explicitly note that *Current* / odd-numbered lines
  "probably work but are not recommended for production" [S5][S6].
- There is **no urgency**: Node 24 (this repo's runtime) is Active LTS with
  **end-of-life 2028-04-30** [S3][S4]. The repo can sit on Node 24 for well over
  a year after Node 26 goes LTS.
- The upgrade is **low technical risk** for this stack (no compiled-from-source
  native addons; see the [compatibility matrix](#3-compatibility-matrix)), but
  it is a **High-risk change to ship** because it touches the runtime, images,
  and CI in one PR. It gets owner review before merge regardless of low code
  risk.

## 1. Current-state inventory (verified in-repo, 2026-07-07)

Every row is a place the coupled PR must touch or account for.

| Surface | Current value | File(s) |
| --- | --- | --- |
| README "Requirements" | "Node.js 24 LTS", "npm 11 or newer" | `README.md:51-55` |
| `package.json` engines | `"node": ">=24.0.0 <25"`, `"npm": ">=11"` | `package.json:15-18` |
| `@types/node` (declared) | `^24` (devDependency) | `package.json:115` |
| `@types/node` (resolved) | `24.13.2` | `package-lock.json` (`node_modules/@types/node`) |
| Docker base + runner image | `node:24.17-alpine` (both `base` and `runner` stages) | `Dockerfile:1,35` |
| Docker global npm pin | `npm install -g npm@11.14.0` | `Dockerfile:2` |
| CI runner Node | `node-version: 24` via `actions/setup-node@v6` (3 workflows, 4 steps: `dependency-review`, `verify`, `migration-drift`, plus e2e and staging-a11y) | `.github/workflows/ci.yml:37,147,213`; `.github/workflows/e2e.yml:48`; `.github/workflows/staging-accessibility.yml:41` |
| CI OS runner | `ubuntu-latest` (all jobs) | `.github/workflows/*.yml` |
| `tsconfig` target / lib | `target: ES2017`, `lib: [dom, dom.iterable, esnext]` — **runtime-agnostic; no change needed** | `tsconfig.json` |
| `tsconfig.test.json` types | `["vitest/globals", "node"]` — picks up whatever `@types/node` is installed | `tsconfig.test.json` |

Companion image tags in compose (not Node, but part of the deploy surface the
window rebuilds): `postgres:16-alpine`, `caddy:2-alpine`
(`docker-compose.yml:106,162`), `axllent/mailpit:v1.30.3`
(`docker-compose.staging.yml:50`). None require change for a Node bump.

Runtime-relevant dependency versions (exact, from `package.json`): `next@16.2.10`,
`@prisma/client`/`prisma`/`@prisma/adapter-pg@^7.8.0`, `react`/`react-dom@19.2.7`,
`vitest@^4.1.9`, `@vitejs/plugin-react@^6.0.3`, `tsx@^4.22.4`,
`@playwright/test@^1.61.1`, `typescript@^6`, `bcryptjs@^3.0.3`,
`node-cron@^4.5.0`.

### Native / prebuilt dependency scan

`package-lock.json` has **zero** `node-gyp` / `gypfile` / `prebuild-install` /
`node-pre-gyp` matches — i.e. **no dependency compiles a native addon against V8
at install time.** The native pieces that exist all ship prebuilt platform
binaries (including `linuxmusl` variants for the Alpine image) and use either
N-API (ABI-stable across Node majors) or a standalone binary:

- `sharp@0.34.5` — optional dep of `next` for image optimization; N-API, prebuilt
  `@img/sharp-*` incl. `linuxmusl`.
- `lightningcss` — N-API (napi-rs), prebuilt per-platform (Tailwind v4 pipeline).
- `@next/swc-*` — N-API (napi-rs), prebuilt per-platform.
- `esbuild` — standalone Go binary (no Node ABI at all); pulled in via Vite/vitest.
- `@prisma/engines` — Prisma's out-of-process/WASM engine artifacts, gated by
  Prisma's Node-support policy rather than Node's ABI.

Consequence: **Node 26's `NODE_MODULE_VERSION` bump to 147** [S2] does **not**
force any source recompile here, because N-API modules are forward-compatible and
esbuild is ABI-independent. The gating factor is vendor *support statements*, not
binary compatibility.

## 2. Node 26 LTS facts (web, cited 2026-07-07)

| Fact | Value | Source |
| --- | --- | --- |
| Node 26.0.0 released | 2026-05-05 ("Current") | [S1][S2] |
| Node 26 → **Active LTS** | **October 2026** | [S1][S2] |
| Node 24 released | 2025-05-06; Active LTS ("Krypton") | [S4] |
| Node 24 → Maintenance LTS | ~October 2026 (when 26 becomes Active LTS) | [S1][S3] |
| **Node 24 end-of-life** | **2028-04-30** | [S3][S4] |
| Schedule change from Node 27 | One major/year (April), every major becomes LTS in October; the odd/even distinction ends. **Node 26 is the last release under the current even-LTS model.** | [S1][S7] |

### Notable breaking changes 24 → 26 relevant to this stack [S2]

- **V8 14.6** (from 13.x); **Undici 8**; **Temporal API on by default**. New JS
  features are additive.
- **Removed APIs**: `crypto.createCipher()` (DEP0182), `http.ServerResponse#writeHeader()`
  (use `writeHead()`), legacy internal `_stream_*` modules. Newly runtime-deprecated:
  `module.register()`, and stream/crypto deprecations promoted to runtime.
- **ESM/CJS**: the extensionless-CJS exception is removed for `type: module`
  packages (stricter resolution).
- **Native addons**: `NODE_MODULE_VERSION` → **147** (matters only for
  compiled-against-V8 addons — this repo has none; see the native scan above).
- **Build/platform** (only affects building Node from source, not the official
  prebuilt Docker images): GCC ≥ 13.2, Python ≥ 3.10, Windows SDK 11.

**Pre-flight grep before the bump PR** (verify none of the removed/deprecated
surfaces are used in app or scripts): `crypto.createCipher(` (the app uses
`createCipheriv` for Xero token encryption — confirm), `writeHeader(`,
`require('_stream`, `module.register(`. Expected result: no hits; the app is
Next.js/route-handler code that does not touch these low-level APIs directly.

## 3. Compatibility matrix (repo's pinned versions vs Node 26)

| Component | Version in repo | Node 26 status | Notes / source |
| --- | --- | --- | --- |
| **Prisma ORM** | `^7.8.0` | ⚠️ not yet listed | System-requirements page lists `^20.19 / ^22.12 / ^24.0` and states it supports/tests all Active + Maintenance LTS; *Current*/odd lines "probably work but not recommended for production." Node 26 lands in-policy once it is Active LTS (Oct 2026). [S5] |
| **Next.js** | `16.2.10` | ⚠️ min Node 20+; no explicit 26 statement | Next 16 requires Node ≥ 20; no Node-26 callout as of access date. [S6] |
| **vitest + worker threads** | `^4.1.9` (`@vitejs/plugin-react@^6`, `@vitest/coverage-v8@^4`) | ✅ covered | vitest 4 engines `^20 || ^22 || >=24` → Node 26 satisfies the range. Worker-thread pool relies on stable `worker_threads` (no removals in 26). [S8] |
| **tsx** | `^4.22.4` | ✅ expected | tsx wraps esbuild (standalone Go binary, ABI-independent); no Node-26 blocker found. Used by `db:seed`, setup, audit, and finance scripts. |
| **Playwright** | `@playwright/test@^1.61.1` | ✅ supported | Current Playwright docs list "Node.js latest 22.x, 24.x or 26.x." Confirm the installed 1.61.x line carries the same statement at window time. [S9] |
| **Native/prebuilt deps** | sharp 0.34.5, lightningcss, `@next/swc`, esbuild, `@prisma/engines` | ✅ no recompile | N-API forward-compatible + standalone binaries; `linuxmusl` prebuilts present. See native scan in §1. |
| **`@types/node`** | `^24` → **`^26`** | must bump *with* runtime | Type defs must match the runtime, not lead it — bumping types alone lets code call Node-26 APIs that crash on a Node-24 runtime (the original #1136 finding). |
| Node engines / npm | `>=24 <25` / `>=11` | Node 26 bundles npm 11.x | engines widen to Node 26; npm floor unchanged. [S2] |

**Blockers today:** none are hard. Prisma and Next simply have not *published*
Node-26 support statements yet, which is exactly what the October 2026 Active-LTS
window resolves. Re-run this matrix at window time and require every ⚠️ to flip to
a published "supported" statement before merging.

## 4. The coupled upgrade change-set (one PR, when the window opens)

A single PR, in an isolated worktree, changing **all** of the following together
(bumping any subset alone is the failure mode #1136 called out):

1. `package.json` — `engines.node` → `">=26.0.0 <27"`; keep `npm` floor (`>=11`)
   unless the target Node 26 minor bundles a newer npm the repo wants to pin.
2. `package.json` devDependencies — `@types/node` → `^26`.
3. `package-lock.json` — regenerate via `npm install` so `@types/node@26.x` and
   any refreshed prebuilt binaries resolve; verify strict peer install still
   passes (repo runs strict peers — no `.npmrc legacy-peer-deps`).
4. `Dockerfile` — `node:24.17-alpine` → `node:26.<minor>-alpine` in **both** the
   `base` (line 1) and `runner` (line 35) stages; re-pin the global
   `npm@<version>` (line 2) to the version shipped/needed.
5. `.github/workflows/ci.yml` — `node-version: 24` → `26` at all three steps
   (`dependency-review`, `verify`, `migration-drift`).
6. `.github/workflows/e2e.yml` — `node-version: 24` → `26`.
7. `.github/workflows/staging-accessibility.yml` — `node-version: 24` → `26`.
8. `README.md:53` — "Node.js 24 LTS" → "Node.js 26 LTS".
9. Doc lockstep — refresh this file's status line, and any other doc that names
   "Node 24" as the requirement (grep `Node.js 24` / `node:24` across `docs/`,
   `README.md`, `CONFIGURATION.md` before merge).

No `tsconfig` change is required (`target`/`lib` are runtime-agnostic).

### Validation gate (full, per `docs/MAINTENANCE.md`)

Local, before pushing (`DATABASE_URL` pointed at an unreachable dummy):

```bash
npm run lint
npm run db:generate
npm run typecheck        # tsc against tsconfig.json + tsconfig.test.json (picks up @types/node@26)
npm test                 # vitest run
npm run build            # prisma generate && next build
```

CI must go green on every required check: `verify`, `Migration drift check`,
`Playwright E2E`, and the `Static analysis gate` (branch-protected on `main`).
Then run the **full Playwright E2E suite** against the staging compose stack
(`npm run test:e2e`, `docs/E2E_PLAYWRIGHT.md`) on the Node 26 image, plus a
**staging soak** (see §6) before any production cutover.

### Rollback plan

The Node version is baked into the container image, so rollback is an
image-tag revert with **no host-side runtime change**:

- Production runs GHCR images `ghcr.io/thatskiff33/alpineclubbookingsnz-app:<ref>`
  and `-migrate:<ref>` behind a blue/green Caddy cutover
  (`scripts/run-production-blue-green-deploy.sh`, services `app`/`app_blue`/
  `app_green`, active upstream `deploy/caddy/tacbookings-active.caddy`).
- **Revert path:** re-point traffic to the still-running previous-color image
  (the deploy script's `rollback_traffic_if_needed`), or redeploy the prior
  commit's image tag by re-running the deploy with the previous `DEPLOY_REF`.
  Because migrations here are backward-compatible per
  `docs/BLUE_GREEN_MIGRATION_POLICY.md`, the Node-24 image can serve the same
  schema — this bump introduces no migration, so rollback is purely the image
  swap.
- **Revert the PR** on `main` (merge-commit revert) to bring `engines`, Docker,
  CI, and README back to Node 24; the next deploy rebuilds a Node-24 image.

## 5. Timeline recommendation

| Option | When | Assessment |
| --- | --- | --- |
| **A — Now (Jul 2026)** | Node 26 still "Current" | **Not recommended.** Runs production on a non-LTS line that Prisma/Next flag as "not recommended for production" [S5][S6]; buys nothing over waiting, since Node 24 is fine until 2028. |
| **B — At Active-LTS entry** ✅ | Shortly after Oct 2026, once §3 is all-green | **Recommended.** Node 26 becomes a supported production LTS; vendors publish Node-26 statements; ~18 months of Node-24/26 overlap before 24 EOL leaves ample buffer. Do it early in the window, not against a deadline. |
| **C — Defer to pressure** | At first Node-26-only dependency requirement, or as Node 24 nears EOL (into 2027/28) | Acceptable fallback if the window can't be scheduled in late 2026. Riskier only if it slips close to the 2028-04-30 EOL, compressing the upgrade against a hard date. |

**Recommendation: Option B.** Open the maintenance window in late 2026 after Node
26 has a few LTS patch releases and after Prisma + Next.js publish Node-26 support
— re-verify the matrix, then ship the §4 change-set as one PR with the full gate
and a staging soak. This also positions the repo for the post-Node-27 annual
cadence [S7] with no Current-line exposure in between.

### Owner GO checkpoint

**Nothing in §4 proceeds without an explicit owner comment on #1176 opening the
maintenance window** (D5 gate; no pre-authorization). Sequence:

1. This planning doc merges on its own (docs-only, auto-merge-eligible).
2. Owner comments on #1176 to **open the window** (ideally after Oct 2026 per
   Option B). Until then the coupled bump stays unscheduled.
3. The bump PR is **High-risk** (runtime + images + CI in one change) and gets
   **owner review before merge** regardless of its low code risk.

## 6. Staging rehearsal note

Rehearse the whole change on the staging stack before any production cutover,
using generic configuration only (public upstream stays generic — `${DOMAIN}`
placeholders, example club config/branding, test/demo credentials; no
club-specific literals). Per `docs/ONGOING-DEVELOPMENT-WORKFLOW.md`, the private
deployment fork syncs the merged upstream `main` and deploys from the fork only.

1. **Build the Node 26 image locally/staging** with the §4 Dockerfile change:
   `docker compose --env-file .env.staging -p tacbookings-staging -f docker-compose.yml -f docker-compose.staging.yml up -d --build postgres app`
   (`docker-compose.staging.yml` header; `CRON_ENABLED=false`, backups off, so no
   scheduled email/Stripe/Xero work fires).
2. **Full Playwright E2E** on the Node 26 image against that stack (`npm run test:e2e`,
   `docs/E2E_PLAYWRIGHT.md`) — the Critical journeys (two-factor login + email code,
   booking capacity lock, Stripe payment, Internet Banking, waitlist, role
   boundaries, membership application) must pass on Node 26 exactly as on 24.
3. **Accessibility/Lighthouse smoke** via `npm run review:staging:a11y`
   (`docs/STAGING_ACCESSIBILITY.md`) to confirm the runtime swap changed no
   rendered output.
4. **Soak** the staging app for a representative period on Node 26 (health at
   `/api/health/ready`), watching logs/Sentry for native-module load errors
   (sharp/lightningcss/swc), Prisma engine start-up, and cron/worker behavior.
5. Only after a clean soak, the private fork runs its own validation and performs
   the **blue/green production cutover** (`scripts/run-production-blue-green-deploy.sh`,
   `docs/BLUE_GREEN_MIGRATION_POLICY.md`), with the §4 image-tag rollback ready.

## Triggers to revisit sooner than Option B

- A security advisory against Node 24 that is fixed only on 26 → escalate the
  window (owner notified, Critical path).
- A dependency the repo needs bumps its Node floor above 24 (Prisma/Next/vitest
  majors) before Oct 2026 → re-evaluate Option C timing.
- Node 26's Active-LTS date slips or the schedule-change details for 27+ alter the
  overlap math [S7].

## Sources

Accessed 2026-07-07.

- [S1]: Node.js — Node.js Releases (previous-releases schedule). https://nodejs.org/en/about/previous-releases
- [S2]: Node.js — Node.js 26.0.0 (Current) release notes. https://nodejs.org/en/blog/release/v26.0.0
- [S3]: Node.js — endoflife.date (Node 24 EOL 2028-04-30). https://endoflife.date/nodejs
- [S4]: Node.js — Node.js 24.x (LTS "Krypton") release info. https://nodejs.org/en/blog/release/v24.11.0
- [S5]: Prisma ORM — System requirements (supported Node versions + LTS policy). https://www.prisma.io/docs/orm/reference/system-requirements
- [S6]: Next.js — Upgrading: Version 16 (Node ≥ 20 requirement). https://nextjs.org/docs/app/guides/upgrading/version-16
- [S7]: Node.js — Evolving the Node.js Release Schedule (annual cadence from Node 27). https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule
- [S8]: Vitest — Getting Started / engines (Node `^20 || ^22 || >=24`). https://vitest.dev/guide/
- [S9]: Playwright — Installation / system requirements (Node 22.x, 24.x, 26.x). https://playwright.dev/docs/intro

[S1]: https://nodejs.org/en/about/previous-releases
[S2]: https://nodejs.org/en/blog/release/v26.0.0
[S3]: https://endoflife.date/nodejs
[S4]: https://nodejs.org/en/blog/release/v24.11.0
[S5]: https://www.prisma.io/docs/orm/reference/system-requirements
[S6]: https://nextjs.org/docs/app/guides/upgrading/version-16
[S7]: https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule
[S8]: https://vitest.dev/guide/
[S9]: https://playwright.dev/docs/intro
