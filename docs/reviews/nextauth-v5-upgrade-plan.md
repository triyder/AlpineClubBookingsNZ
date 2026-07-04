# next-auth v5 Stable Upgrade — Research and Plan (issue #1143)

Date: 2026-07-04. Docs-only deliverable for epic #1125 [Quality 18]; the
implementation decision for [Quality 19] (#1144) is recorded at the end.

## Executive summary — go/no-go

**No-go.** There is no next-auth v5 stable to upgrade to, and none is planned.

- The npm `beta` dist-tag is `5.0.0-beta.31` (published 2026-04-14) — the
  version this repo already runs. `latest` is still the v4 line (4.24.14).
- In 2026 the Auth.js project was placed under the stewardship of the Better
  Auth team ([nextauthjs/next-auth discussion #13252]). The maintainers state
  they have "no immediate plans" for a v5 stable release; the commitment is
  maintenance of both lines "for security and urgent issues", and their
  recommendation for new projects is Better Auth.
- Consequence: the "upgrade to v5 stable" scoped by #1144 cannot be executed.
  #1144 closes as deferred; the near-term hygiene items and the strategic
  option below are filed as follow-up issues.

## Current state (verified in-repo, 2026-07-04)

| Item | State |
| --- | --- |
| `next-auth` | `5.0.0-beta.31`, exact-pinned — the newest release of the v5 line |
| `@auth/prisma-adapter` | `^2.11.2` declared, **zero imports anywhere** — dead dependency (`src/lib/prisma-adapter.ts` is Prisma's PG driver adapter, unrelated) |
| `.npmrc` | `legacy-peer-deps=true`, repo-wide |
| Session strategy | JWT, 8h maxAge (30 days for LODGE kiosk accounts), no database sessions, no OAuth providers |
| Import surface | 13 files. Server: `NextAuth`, `Credentials`, `CredentialsSignin`, `NextAuthConfig` (`src/lib/auth.ts`). Client: `useSession`/`signIn`/`signOut`/`SessionProvider` from `next-auth/react` |
| Unstable API use | `unstable_update` (re-exported as `updateSession`) — the one API expected to be renamed in any stable release |

### Why `legacy-peer-deps=true` exists (verified by strict-peer dry run)

`next-auth@5.0.0-beta.31` declares an **optional** peer `nodemailer@^7.0.7`;
the repo ships `nodemailer@9`. npm treats a version conflict on an installed
optional peer as an ERESOLVE error, so strict installs fail on exactly one
edge:

```
npm error Conflicting peer dependency: nodemailer@7.0.13
npm error   peerOptional nodemailer@"^7.0.7" from next-auth@5.0.0-beta.31
```

`next@^14||^15||^16` and `react@^19` peers are satisfied — Next 16 is *not*
the conflict. The app never uses next-auth's email/nodemailer provider (the
Credentials provider is the only one configured; all app email goes through
`src/lib/email*`), so the mismatch is harmless at runtime and the blanket
`legacy-peer-deps` can be replaced with a targeted `overrides` entry
(`"next-auth": { "nodemailer": "$nodemailer" }`), restoring strict peer
checking for every other package. Verified: that override is the only change
strict mode needs today.

### Auth behaviours any future migration must preserve

These are the load-bearing behaviours in `src/lib/auth.ts` (plus
`src/lib/session-guards.ts`, `src/lib/two-factor.ts`) that make auth changes
High-risk here — each needs an explicit test before/after any swap:

1. **Credentials authorize hardening** — timing-safe dummy bcrypt compare for
   unknown emails (anti-enumeration), `canLogin`/`active` gating, and the
   typed `EmailNotVerifiedError extends CredentialsSignin` login-page code.
2. **2FA session challenge** — the JWT `update` trigger is reachable by any
   authenticated client via `POST /api/auth/session`, so
   `twoFactorVerified` is only honoured when the update carries the
   single-use server-minted challenge token, consumed via
   `consumeTwoFactorSessionChallenge()`. Client-supplied session fields are
   never trusted. Module-flag-driven `twoFactorRequired` recomputes on every
   JWT refresh.
3. **`forcePasswordChange` gating** — refreshed from the database on every
   request in the `jwt` callback (not only at sign-in), so an admin reset
   takes effect immediately.
4. **Session invalidation on password change** — `sessionInvalidated` is
   derived from `passwordChangedAt > sessionIssuedAt` and enforced by the
   custom `auth()` wrapper returning `null`; guards in
   `session-guards.ts` depend on that wrapper, not on raw `nextAuth.auth()`.
5. **Role/access-role freshness** — `role` and `accessRoles` reload from the
   database in the `jwt` callback so revocations apply without waiting for
   JWT expiry; LODGE kiosk accounts get a 30-day `exp` override.

## Options considered

**A. Upgrade to v5 stable now (the #1144 scope)** — impossible; no such
release exists and the maintainers plan none. *Rejected.*

**B. Stay on `5.0.0-beta.31` + dependency hygiene** — *recommended posture.*
beta.31 is the newest v5 release, production-proven in this deployment,
carries no published advisory (every next-auth GHSA to date affects the ≤4.24
line or adapters this repo does not use), and the vendor commitment covers
security fixes. Hygiene items (follow-up issue): drop the unused
`@auth/prisma-adapter`; replace `.npmrc` `legacy-peer-deps=true` with the
targeted nodemailer override so strict peer checking protects the other ~90
dependencies.

**C. Migrate to Better Auth** — the strategic successor per the Auth.js
maintainers. Feasible here: Better Auth expects a database (this repo has
Postgres/Prisma) and supports credentials, TOTP/email 2FA plugins, and custom
session claims. It is a full auth-layer replacement: the five behaviours
above, the login/2FA UI flows, `session-guards.ts`, and the E2E auth specs
all move. Estimate: a multi-PR project with full Playwright coverage before
and after — not a quality-wave item. *Deferred; evaluation filed as backlog.*

**D. Downgrade to v4 stable (4.24.14)** — regressive: different API family
(`getServerSession` vs `auth()`), App Router ergonomics lost, migration cost
paid backwards for a line that is also in maintenance. *Rejected.*

## Triggers to revisit

Re-open the upgrade question when any of these fire:

1. A security advisory lands against `next-auth@5.0.0-beta.x` — apply the
   patched release immediately (Critical path, owner notified).
2. A v5 stable (or renamed successor) actually ships — run the checklist
   below.
3. A future Next.js major falls outside beta.31's `^14||^15||^16` peer range.
4. Better Auth's migration guides for Auth.js users mature and the club
   schedules the strategic migration (option C).

## Checklist if a v5 stable ever ships

1. Read the beta→stable changelog; expected deltas from beta.31 are small.
   Specifically verify: `unstable_update` rename (repo re-exports it as
   `updateSession`), `CredentialsSignin` subclass error codes surfacing on
   the login page, JWT callback `trigger === "update"` semantics (the 2FA
   challenge path depends on it), module augmentation paths
   (`declare module "next-auth"`), and `next-auth/react` client exports.
2. Check the stable's peer ranges — if `nodemailer` widens to ^9 or the peer
   is dropped, remove the override; `.npmrc` stays clean either way.
3. Bump in an isolated worktree; run the full gate
   (lint/typecheck/test/build) plus the **entire Playwright E2E suite before
   and after** (per #1144's instructions), with explicit manual checks of:
   login, wrong-password, unverified-email code, forced password change,
   2FA enrol + verify + recovery, session invalidation after password
   change, kiosk session longevity, and admin role revocation taking effect.
4. Owner review before merge — auth is a Critical-risk area; the epic's
   pre-authorization was scoped to the quality wave, not to a future bump.

## Decision for #1144 ([Quality 19])

Closed as **deferred (no-go)**: the scoped work ("implement the v5 stable
upgrade") has no upgrade target. Follow-ups filed instead:

- **next-auth dependency hygiene** — remove the unused `@auth/prisma-adapter`;
  swap blanket `legacy-peer-deps=true` for the targeted nodemailer override;
  keep `next-auth` exact-pinned. Small, mechanical, fully testable.
  _✅ Resolved by #1182 (2026-07-04): `@auth/prisma-adapter` removed, `.npmrc`
  deleted, `overrides."next-auth".nodemailer` added; strict `npm install`
  succeeds. The "Current state" table above is a point-in-time snapshot of the
  pre-#1182 tree and is retained as historical record._
- **Evaluate Better Auth migration** — scoped evaluation of option C with a
  prototype behind the module-flag system, feature-parity matrix for the five
  load-bearing behaviours, and a phased cutover plan.

[nextauthjs/next-auth discussion #13252]: https://github.com/nextauthjs/next-auth/discussions/13252
