# Better Auth Migration — Evaluation (issue #1183)

Date: 2026-07-07. Docs-only deliverable. Companion to
`docs/reviews/nextauth-v5-upgrade-plan.md` (issue #1143), which this doc treats
as its baseline for the five load-bearing auth behaviours and its house style.

## Executive summary — recommendation

**Stay put on the pinned `next-auth@5.0.0-beta.31`; hold Better Auth as a
documented strategic option behind explicit revisit triggers.** A prototype
should be commissioned only after an explicit owner GO (see §6).

Better Auth is real, actively maintained, and technically capable of covering
this app's auth surface, but a migration is a large, Critical-risk, multi-PR
project against the single most security-sensitive part of the system. Of the
five load-bearing behaviours, only two map cleanly onto native Better Auth
mechanisms; the other three need custom code, and the migration also collides
with a deliberate domain-schema decision (family members share an email address,
so `Member.email` is **not** globally unique — Better Auth's `user` table wants
it to be). None of the revisit triggers from the baseline plan has fired: no
advisory against beta.31, no Next.js major outside its peer range, and the
Auth.js line remains maintained for security fixes. There is no forcing function
to pay this cost now.

## 1. Context and gate

- **Gate.** This issue is **GATED — research-only**, per Decision-menu **D4**
  (owner-ratified 2026-07-04) and re-affirmed when the issue was spun out of the
  closed epic #1204 on 2026-07-05: Better Auth is the *strategic successor*
  decision to the next-auth line and may eventually supersede it, but it stays
  **decoupled and research-only**. No implementation, migration, dependency
  install, schema change, or auth-code edit may begin without an explicit
  **owner GO**.
- **Scope of this document.** Documentation-based evaluation only: a
  feature-parity matrix for the five behaviours, a schema-delta assessment from
  Better Auth's published schema, a client-surface swap assessment, and a
  recommendation with an owner checkpoint. **No code, schema, config, or
  dependency was touched to produce it.**
- **Deferred.** The issue's original "prototype Better Auth in a throwaway
  branch" step is **explicitly deferred**. The hands-on prototype is the *next
  step after owner GO*, and §6 scopes it so it can be commissioned cleanly.
- **Risk class.** Auth migration is **Critical-risk** and outside every existing
  pre-authorization; it requires owner review before any merge regardless of how
  the phased plan is sequenced.

## 2. Feature-parity matrix — the five load-bearing behaviours

Verdict legend: **native** (a stock Better Auth option covers it) · **plugin**
(an official plugin covers it) · **custom** (parity needs bespoke code on top of
Better Auth) · **prototype** (cannot be resolved from docs; must be proven
hands-on).

### (a) Anti-enumeration credentials `authorize`

- **Current.** `src/lib/auth.ts:116-173`. Timing-safe dummy bcrypt compare for
  unknown/inactive accounts (`DUMMY_PASSWORD_HASH`, `src/lib/auth.ts:30-31`,
  applied at `:135-138`) so known and unknown emails cost the same wall-time;
  `canLogin`/`active` gating (`:131-138`); typed
  `EmailNotVerifiedError extends CredentialsSignin` surfacing an
  `EMAIL_NOT_VERIFIED` code on the login page (`:23-25`, thrown `:146-148`).
- **Better Auth mechanism.** Email/password is native
  (`emailAndPassword.enabled`); `requireEmailVerification: true` blocks
  unverified sign-in natively and, per the docs, "returns a success response
  instead of an error to prevent user enumeration" (follows OWASP guidance).
  Existing bcrypt hashes can be retained via a custom
  `emailAndPassword.password.{hash,verify}` pair (default is scrypt), so a hash
  re-encoding migration is avoidable. See email-password and options docs.
- **Verdict: native + custom.** Email/password, verification gating, and generic
  error responses are native; the `canLogin` domain gate (only login-capable
  adult members may authenticate) and the specific *constant-time* guarantee for
  unknown emails are not configuration knobs and need bespoke code plus a timing
  test to confirm parity.
- **Risk.** Better Auth's generic-response behaviour is documented for the
  *sign-up* path; the *sign-in* timing profile for a non-existent user must be
  measured, not assumed — flagged **prototype** for the timing check.

### (b) Server-minted single-use 2FA session challenge

- **Current.** `src/lib/two-factor.ts:215-252`
  (`createTwoFactorSessionChallenge` / `consumeTwoFactorSessionChallenge`),
  `src/lib/two-factor-api.ts:75-100` (`markTwoFactorSessionVerified` →
  `updateSession`), and the JWT `update`-trigger handler at
  `src/lib/auth.ts:191-215`. The mechanism exists **because** next-auth's JWT
  `update` trigger is reachable by any authenticated client via
  `POST /api/auth/session`, so `twoFactorVerified` is honoured only when the
  update carries a single-use, server-minted token
  (`prisma/schema.prisma:666-677`). `twoFactorRequired` recomputes on every JWT
  refresh (`src/lib/auth.ts:226-227,251`).
- **Better Auth mechanism.** The `twoFactor` plugin. On sign-in for a
  2FA-enabled user the credential response sets `twoFactorRedirect: true` and
  **no authenticated session is created** until the second factor is verified
  server-side (`auth.api.verifyTOTP` / `auth.api.verifyTwoFactorOTP`). Because
  the client never sets a "verified" flag and the session is minted only *after*
  server verification, the entire client-forgery attack surface this repo
  defends against does not exist in Better Auth's model — the challenge-token
  machinery becomes unnecessary. TOTP, email OTP (`sendOTP`), and 10 single-use
  backup codes are all native to the plugin.
- **Verdict: plugin** (a strict improvement — the bespoke challenge file is
  retired).
- **Risk.** The app's **org-wide 2FA mandate** is a different policy: the
  `twoFactor` module flag (`ClubModuleSettings.twoFactor`,
  `prisma/schema.prisma:2483`; read at `src/lib/auth.ts:226-227`) forces even
  *un-enrolled* members to enroll before proceeding (`/login/enroll`, see
  `src/lib/two-factor-gate.ts`). Better Auth's plugin only challenges users who
  have *already* enabled 2FA; the "required-but-not-yet-enrolled ⇒ force enroll"
  gate is **custom** middleware/hook work on top of the plugin.

### (c) Per-request `forcePasswordChange` refresh

- **Current.** Refreshed from the database in the JWT callback on **every**
  request, not only at sign-in (`src/lib/auth.ts:246`, inside the
  `:220-273` per-request refresh block), so an admin reset takes effect on the
  next request. Independently enforced by the server guards, which re-read the
  member from the DB (`src/lib/session-guards.ts:151-159` and `:241-246`).
- **Better Auth mechanism.** Two options: (1) the `customSession` plugin runs a
  server-side callback on every `getSession` and can project a fresh
  `forcePasswordChange` read from the member row; (2) — already true in this
  codebase — the server guards read the member from the DB themselves, so
  enforcement never depended solely on the token claim and survives the swap
  largely unchanged.
- **Verdict: plugin** (or effectively already-covered by the DB-reading guards).
- **Risk.** If `session.cookieCache` is enabled for performance, cached session
  snapshots go stale for up to `maxAge`; `customSession` still runs per request,
  but any *client* component reading `forcePasswordChange` off the cached cookie
  would lag. Keep cookie cache off (or very short) for this field, or read it
  only server-side.

### (d) Password-change session invalidation via `sessionIssuedAt`

- **Current.** `sessionInvalidated` is derived from
  `passwordChangedAt > sessionIssuedAt` (`src/lib/auth.ts:248-250`;
  `sessionIssuedAt` stamped at sign-in `:183`, preserved via
  `getTokenSessionIssuedAtMs` `:93-109,217-218`; `passwordChangedAt` column at
  `prisma/schema.prisma:374`) and enforced by the custom `auth()` wrapper
  returning `null` (`src/lib/auth.ts:323-331`). This is a workaround for JWTs
  being stateless — there is no server-side session row to delete.
- **Better Auth mechanism.** Native, and cleaner: with **database sessions**,
  `changePassword({ revokeOtherSessions: true })` deletes the other session rows
  server-side, so they stop resolving immediately; admin-initiated resets call
  `revokeSessions` for the target user. No `sessionIssuedAt` bookkeeping and no
  null-returning wrapper needed.
- **Verdict: native.**
- **Risk.** This parity is contingent on adopting Better Auth's **stateful
  database-session** model (see §3) — it is the behaviour that most strongly
  argues *against* trying to keep a stateless/JWT posture through the migration.
  The revoke-on-admin-reset path must be wired into the existing admin
  password-reset flow explicitly; it is not automatic.

### (e) Per-request role/access-role freshness + 30-day LODGE kiosk override

- **Current.** `role`, `accessRoles`, and the merged `adminPermissionMatrix`
  reload from the DB in the JWT callback on every request
  (`src/lib/auth.ts:229-245`) so revocations apply without waiting for JWT
  expiry; `requireAdmin` additionally re-reads and DB-verifies these
  (`src/lib/session-guards.ts:115-128,176-184`). LODGE kiosk accounts get a
  **30-day** `exp` override for the shared iPad (`src/lib/auth.ts:268-271`).
- **Better Auth mechanism.** Role freshness maps to the `customSession` plugin
  (fresh per-request DB projection of roles) and is *also* already provided by
  the DB-verifying guards. The **30-day kiosk override is the problem**: Better
  Auth sessions have a single global `expiresIn` (default 7 days); a *per-user
  variable* session lifetime keyed on the LODGE access role is **not** native
  and needs a session-creation database hook that stretches `expiresAt` for
  LODGE members.
- **Verdict: plugin** (role freshness) **+ custom** (per-user kiosk session
  lifetime).
- **Risk.** `customSession` `additionalFields` have documented rough edges —
  custom fields can be stripped from the client `getSession` payload and have
  type-inference gaps (better-auth issues #3888, #1194, #5700). Since admin UI
  gating reads `role`/`accessRoles`/`adminPermissionMatrix` off `session.user`
  client-side (§4), this is a real **prototype** item: confirm the custom claims
  reach the client, or move those reads server-side.

### Matrix summary

| Behaviour | Verdict | Net effect |
| --- | --- | --- |
| (a) Anti-enumeration authorize | native + custom | Email/pw native; `canLogin` gate + constant-time proof are custom/**prototype** |
| (b) 2FA session challenge | plugin | Bespoke challenge file retired; **org-wide mandate + force-enroll is custom** |
| (c) `forcePasswordChange` refresh | plugin | `customSession`, or already covered by DB-reading guards |
| (d) Password-change invalidation | native | `revokeOtherSessions` — **requires adopting DB sessions** |
| (e) Role freshness + kiosk `exp` | plugin + custom | Freshness native-ish; **per-user 30-day kiosk lifetime is custom** |

## 3. Schema delta assessment (schema-gated work)

Better Auth's Prisma adapter expects its own core tables. Per the database and
Prisma-adapter docs, the core is four tables — **`user`**, **`session`**,
**`account`**, **`verification`** — and the `twoFactor` plugin adds a
**`twoFactor`** table plus a `user.twoFactorEnabled` column. The schema is
produced with `npx @better-auth/cli generate` and applied with Prisma's own
`migrate`/`db push` (the CLI's `migrate` subcommand is Kysely-only).

This repo has **none** of these tables: the `Member` model *is* the auth user,
credentials live on `Member.passwordHash`, sessions are stateless JWTs (no
session table), and 2FA is normalised across `Member` columns plus
`TwoFactorEmailCode` / `TwoFactorRecoveryCode` / `TwoFactorSessionChallenge`.
The delta is therefore large, and four points are load-bearing:

1. **`user` ↔ `Member` mapping.** Better Auth supports `user.modelName` and
   `user.fields` to point at an existing table (`modelName: "Member"`, map
   `emailVerified`, timestamps, etc.). `Member` already has `emailVerified`
   (`prisma/schema.prisma:384`), `createdAt`/`updatedAt` (`:439-440`), and a
   `cuid` `id`. Caveats: the `id` field **cannot** be renamed (better-auth issue
   #5807 — fine here, both are `id`); Better Auth expects a single `user.name`
   whereas `Member` stores `firstName`/`lastName` (needs a mapped/added `name`
   column or an `additionalFields` shim); and custom column-name mapping has open
   bugs (#3212, #3774). **Prototype-gated.**

2. **Email uniqueness conflict (the hard one).** Better Auth's `user` table
   treats `email` as unique. This repo **deliberately removed** the global unique
   constraint (`prisma/migrations/20260408030000_remove_email_full_unique`,
   `20260411170000_drop_member_email_primary_unique`) and replaced it with a
   *partial* unique index `Member_email_login_unique ON ("email") WHERE
   "canLogin" = true` (`prisma/migrations/20260408010000_add_can_login_field`),
   because family members and children share one email and only the
   login-capable adult is unique. Better Auth's email lookups assume one user per
   email. Reconciling this — restricting Better Auth to the `canLogin` subset, or
   splitting auth identity from the `Member` row — is the **single biggest
   architectural obstacle** and must be resolved before any cutover.

3. **Credential relocation.** Better Auth stores the credential password on
   `account.password` (provider `credential`), not on the user. Migrating means
   creating an `account` row per login-capable member and backfilling
   `Member.passwordHash` → `account.password` (retaining bcrypt via custom
   `password.verify`). One-way data migration; needs a reversible plan.

4. **Stateful sessions + 2FA storage.** A `session` table makes auth
   **stateful** (a row written per login, read/deleted on revoke) — the enabler
   for behaviour (d), but a genuine architecture shift from today's stateless
   JWT. Separately, Better Auth's `twoFactor` table stores `secret` and
   `backupCodes` on one row, whereas this repo AES-256-GCM-encrypts `totpSecret`
   and stores individually-hashed recovery-code rows
   (`prisma/schema.prisma:649-661`); reconciling the at-rest encryption and the
   code-storage shape is bespoke migration work. The repo's
   `TwoFactorSessionChallenge` table (`:666-677`) is retired entirely (see 2b).

**Classification:** all of the above is **schema-gated**, Critical-risk, and
requires a shadow-DB drift check (`npm run db:check-drift`) and owner review. It
is explicitly out of scope for this research-only issue.

## 4. Client-surface swap assessment

Grep-verified import surface (excluding tests): **12** client files import from
`next-auth/react`, plus `src/lib/auth.ts` (server config) — 13 files, matching
the baseline plan's count — and the `src/types/next-auth.d.ts` module
augmentation (a 14th, type-only). Better Auth's React client
(`authClient.useSession` / `authClient.signIn.email` / `authClient.signOut`)
needs **no `SessionProvider`** (it uses a nanostore), so the provider file is
deleted rather than swapped.

| File | API used | Swap difficulty |
| --- | --- | --- |
| `src/components/app-providers.tsx` | `SessionProvider` (×3) | Low — remove provider entirely |
| `src/app/(public)/login/login-form.tsx` | `signIn` | Medium — `authClient.signIn.email`; must handle `twoFactorRedirect` + `EMAIL_NOT_VERIFIED` |
| `src/components/nav-bar.tsx` | `signOut` | Low — `authClient.signOut` |
| `src/app/(public)/change-password/page.tsx` | `signOut` | Low — `authClient.signOut` |
| `src/hooks/use-admin-area-edit-access.ts` | `useSession` | **Medium/High** — reads custom claims |
| `src/app/(authenticated)/book/_hooks/use-booking-wizard.ts` | `useSession` | Medium — reads custom claims |
| `src/app/(admin)/admin/access-roles/page.tsx` | `useSession` | **Medium/High** — reads `role`/`accessRoles`/matrix |
| `src/app/(admin)/admin/membership-cancellations/page.tsx` | `useSession` | Medium/High |
| `src/app/(admin)/admin/members/[id]/_components/member-credit-card.tsx` | `useSession` | Medium/High |
| `src/app/(admin)/admin/members/[id]/page.tsx` | `useSession` | Medium/High |
| `src/app/(admin)/admin/members/page.tsx` | `useSession` | Medium/High |
| `src/app/(admin)/admin/refund-requests/page.tsx` | `useSession` | Medium/High |
| `src/lib/auth.ts` | server config | High — full rewrite (§2, §3) |
| `src/types/next-auth.d.ts` | module augmentation | Low — replaced by Better Auth's inferred types |

The `useSession` call swap itself is mechanical; the risk is **not** the hook —
it is that eight of these components read **custom** claims (`role`,
`accessRoles`, `adminPermissionMatrix`, `twoFactorVerified`,
`forcePasswordChange`) off `session.user`, and Better Auth is documented to strip
`additionalFields` from the client `getSession` payload for some setups
(better-auth #3888/#1194/#5700). Whether those claims survive to the client is
the pivotal client-side prototype question; if they do not, these components must
move their gating to server components or dedicated endpoints.

**`src/lib/session-guards.ts` (server).** The guards call the custom `auth()`
wrapper (`src/lib/auth.ts:323`), then re-read the member from the DB and
DB-verify `active` / `accessRoles` / `adminPermissionMatrix` /
`forcePasswordChange` / the 2FA gate (`src/lib/session-guards.ts:104-261`).
Under Better Auth: `auth()` becomes `auth.api.getSession({ headers })`; the
`sessionInvalidated` null-return wrapper (`src/lib/auth.ts:326-330`) is deleted
because a revoked DB-session simply fails to resolve; and the DB-verification
blocks stay almost unchanged because they read `Member` directly, independent of
the auth library. **Difficulty: Medium** — a focused, well-tested edit, and the
guards' DB-first design is what makes the rest of the swap tractable.

## 5. Recommendation — reasoned stay-put

**Recommendation: stay put on `next-auth@5.0.0-beta.31`.** Hold Better Auth as a
documented strategic option and re-open only when a revisit trigger fires.

**Why stay put is legitimate, not lazy.**

- beta.31 is the newest release of the v5 line, production-proven in this
  deployment, carries no published advisory, and the vendor commitment covers
  security fixes (baseline plan §"Options", nextauthjs/next-auth #13252). The
  repo can run it **indefinitely**.
- The migration is Critical-risk against the most sensitive surface, and the
  §2 matrix shows only two of five behaviours are native wins; the rest are
  custom or prototype-gated, and behaviour (d)'s native win is *conditional on*
  adopting stateful DB sessions.
- §3 surfaces a hard domain conflict (family-shared email vs Better Auth's unique
  `user.email`) and a credential-relocation data migration — neither is a
  refactor, both are one-way and schema-gated.
- **No trigger has fired** (baseline plan §"Triggers to revisit"): no advisory
  against beta.31, no Next.js major outside its `^14||^15||^16` peer range, and
  Better Auth's Auth.js *migration guides* have not been exercised here. Cost is
  certain and large; benefit is currently strategic-only.

**Revisit triggers (raise priority when any fires).**

1. A security advisory lands against `next-auth@5.0.0-beta.x` with no timely
   patch on the v5 line (Critical path — owner notified immediately).
2. A future Next.js major falls outside beta.31's peer range.
3. Better Auth ships/matures a first-class Auth.js→Better Auth migration path,
   *and* the club schedules the work deliberately.
4. A new requirement appears that next-auth's stateless model serves poorly and
   Better Auth's stateful sessions serve well (e.g. an admin "sign out this user
   everywhere" console).

**If/when the owner GOes, the phased cutover plan is:**

- **Phase 0 — Prototype (throwaway branch, §6).** Resolve the open questions,
  especially the email-uniqueness conflict, credential relocation, and whether
  custom claims reach the client. Owner checkpoint before Phase 1.
- **Phase 1 — Schema (behind a flag, no cutover).** Add Better Auth's tables via
  `@better-auth/cli generate` → Prisma migration + backfill; dual-write only;
  `db:check-drift` green. **Owner checkpoint** (schema-gated, Critical).
- **Phase 2 — Server auth swap.** Replace `src/lib/auth.ts`, rewire
  `session-guards.ts` / `two-factor-api.ts`, wire the org-wide 2FA mandate and
  the LODGE 30-day session hook. Feature-flag old vs new. **Owner checkpoint.**
- **Phase 3 — Client swap.** The 12 `next-auth/react` files → `authClient`;
  delete `SessionProvider`; resolve custom-claim client access. **Owner
  checkpoint.**
- **Phase 4 — Cutover + cleanup.** Flip the flag, remove next-auth and the
  challenge-token machinery, drop dead tables. **Owner checkpoint.**

**Gate for every phase:** the **entire Playwright E2E auth suite before and
after** — `e2e/auth.setup.ts`, `e2e/two-factor-login.spec.ts`,
`e2e/two-factor-email.spec.ts`, `e2e/admin-roles.spec.ts`,
`e2e/access-role-management.spec.ts` — plus explicit manual checks of: login,
wrong-password timing, unverified-email code, forced password change, 2FA enrol +
verify + recovery + email-OTP, session invalidation after password change, kiosk
30-day session longevity, and admin role revocation taking effect on the next
request. Auth E2E coverage may need *extending* before Phase 2 (only two
2FA-specific specs exist today).

**Rollback:** each phase sits behind a feature flag with next-auth retained until
Phase 4; any phase reverts by flipping the flag back. Because Phase 1 only
dual-writes (no destructive drop until Phase 4), the schema can be rolled forward
and back without data loss until the final cleanup, which is itself a separate,
owner-gated migration.

## 6. Prototype charter (deferred — commissions after owner GO)

The throwaway-branch prototype (issue #1183's deferred step) is well-scoped once
the owner GOes. It must **not** touch `main`, production data, or live providers,
and its only deliverable is findings appended here. It should answer, in order of
risk:

1. **Email uniqueness.** Can Better Auth run against the partial-unique
   (`canLogin`) email model, or must auth identity be split from the `Member`
   row? This is the go/no-go question — resolve it first.
2. **`user` ↔ `Member` mapping.** Map `user.modelName: "Member"` + `fields`
   (incl. the `name` vs `firstName`/`lastName` gap) and confirm no `id`-mapping
   or custom-column bug (#3212/#5807) blocks it.
3. **Credential relocation.** Prove `Member.passwordHash` → `account.password`
   with a custom bcrypt `password.verify`, so no member is forced to reset.
4. **Anti-enumeration timing.** Measure sign-in wall-time for existent vs
   non-existent emails under Better Auth; confirm parity with the dummy-compare
   guarantee or add one.
5. **2FA parity.** Reproduce TOTP + email-OTP + recovery through the plugin, and
   prototype the **org-wide mandate + force-enroll** gate the plugin does not do
   natively.
6. **Custom-claim client reach.** Verify `role` / `accessRoles` /
   `adminPermissionMatrix` / `twoFactorVerified` survive to the client
   `useSession` payload (the §4 risk), or design the server-side fallback.
7. **Kiosk session lifetime.** Prototype the per-user 30-day `expiresAt` hook for
   LODGE members and confirm normal accounts keep the short lifetime.

Output: a "Prototype findings" addendum to this doc plus a go/no-go on Phase 1,
for the owner's decision — no merge to `main` from the prototype branch.

## Sources (accessed 2026-07-07)

- Better Auth — 2FA plugin: <https://better-auth.com/docs/plugins/2fa>
- Better Auth — Session management:
  <https://better-auth.com/docs/concepts/session-management>
- Better Auth — Database / core schema:
  <https://better-auth.com/docs/concepts/database>
- Better Auth — Prisma adapter: <https://better-auth.com/docs/adapters/prisma>
- Better Auth — CLI (`@better-auth/cli generate`):
  <https://better-auth.com/docs/concepts/cli>
- Better Auth — Email & password (custom `password.hash`/`verify`,
  `requireEmailVerification`, enumeration): consulted via the email-password and
  options docs at <https://better-auth.com/docs/reference/options>
- Better Auth — npm (latest stable 1.6.23; 1.7.0-rc.1 2026-07-02):
  <https://www.npmjs.com/package/better-auth>
- better-auth issues on `additionalFields`/custom-column edges: #3888, #1194,
  #5700 (custom-session/client fields), #3212/#3774 (custom column names),
  #5807 (id-field mapping) — <https://github.com/better-auth/better-auth/issues>
- Auth.js maintenance / security-fixes-only, no v5 stable planned, Better Auth
  recommended for new work:
  <https://github.com/nextauthjs/next-auth/discussions/13252>
