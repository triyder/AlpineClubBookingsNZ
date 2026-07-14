# Concurrency and advisory locking

How the app serialises the operations that would otherwise race — overbooking a
lodge, double-restoring a member's credit, two people holding the same night,
two runners generating one roster. Every mechanism here is a **PostgreSQL
transaction-scoped advisory lock** (`pg_advisory_xact_lock(...)`): it is held
for the life of the enclosing transaction and released automatically on commit
or rollback. There is no row-level locking discipline to learn beyond these.

This doc maps **which locks exist, what each one protects, and how they
interact**. It is descriptive of the code as it stands — read it before changing
any lock key, adding a capacity/credit write path, or converting a global lock to
a scoped one.

> Why advisory locks and not unique constraints? Several of these invariants are
> cross-row or cross-table (e.g. "a member can't hold two bookings covering the
> same night" spans `BookingGuest` → `Booking`), or need a **partial** unique
> index Prisma cannot express and `db:check-drift` would then reject. Where a
> DB constraint *can* carry the invariant it is preferred; where it can't, an
> advisory lock serialises the check-then-write instead.

## The lock families

All keys below are the argument(s) to `pg_advisory_xact_lock`. Two-argument keys
use `(namespace, subject)`; single-argument keys hash a descriptive string.

| Lock | Key | Helper / where | Serialises |
| --- | --- | --- | --- |
| **Global booking** | `1` (literal) | inline `tx.$executeRaw` | Legacy club-wide capacity/credit critical section; still the sole serialiser for several cancel/claim paths (see below). |
| **Per-lodge capacity** | `hashtextextended(<lodgeId>, 0)` | `acquireLodgeCapacityLock(tx, lodgeId)` (`capacity.ts`) | Capacity claims/checks for one lodge, so bookings at different lodges never contend. |
| **Per-member credit ledger** | `hashtext("member-credit-ledger"), hashtext(<memberId>)` | `lockMemberCreditLedger(memberId, tx)` (`member-credit.ts`) | A member's credit-ledger balance operations (negative-adjustment validation, orphan-restore repair). |
| **Member lifecycle** | `hashtext("member-lifecycle:<memberId>")` | inline (`member-lifecycle-actions.ts`) | Archive/delete of one member. |
| **Membership application** | `hashtext(<application key>)` | `membershipApplicationLockKey` (`nomination.ts`) | State transitions of one membership application. |
| **Membership applicant** | `hashtext(<applicant-email key>)` | `membershipApplicationApplicantLockKey` (`nomination.ts`) | Per-email applicant dedup at submit time. |
| **Roster generation** | `hashtext("roster:<date>")` | inline (`admin-roster-service.ts`) | Roster generation for one calendar date (keyed on the date only, not per lodge). |
| **Config-transfer import** | `hashtext("config-transfer-import")` | `acquireConfigImportLock(tx)` (`config-transfer/apply.ts`) | Single-flights configuration-bundle apply so two admins cannot import concurrently. |
| **Membership subscription billing** | `hashtext("membership-subscription-billing:<seasonYear>")` | `confirmSubscriptionBillingPreview` (`membership-subscription-billing.ts`) | Serialises annual/approval charge snapshot creation for one membership year; the unique subscription-coverage row is the final replay/concurrency guard. |

The first three are the **booking / capacity / credit cluster** — they interact,
and are where the current tensions live. Families 4–8 are independent
single-domain locks; they take distinct keys and do not contend with the cluster
or each other, so this doc does not detail them further beyond the table.

## The two disciplines

Every writer in the cluster follows one of two ordering rules. Getting the order
wrong re-opens the exact races the locks exist to prevent.

### 1. Lock-before-guard (the member-night invariant)

"A member cannot hold two bookings covering the same night" is enforced by
`assertNoBookingMemberNightConflicts`, and **every** transaction that creates or
re-dates a member-linked `BookingGuest` footprint takes the **global booking
lock (`1`) before running the guard**. That ordering is frozen for every such
writer by `review-findings-contracts.test.ts` — add a new member-night writer and
that test requires it to take the lock first. (See `DOMAIN_INVARIANTS.md` for the
full statement, including which writes legitimately skip the guard.)

### 2. Read-key → lock → re-read (the per-lodge capacity paths)

The per-lodge lock key needs the booking's `lodgeId`, which you only know after
reading the row — so these paths **cannot** lock before their first read. The
safe pattern, used throughout, is:

1. Read only `{ lodgeId }` (plus any cheap early-bail fields). `lodgeId` is
   immutable, so keying the lock from this read is always safe.
2. `acquireLodgeCapacityLock(tx, lodgeId)`.
3. **Re-read the full row under the lock** and consume only that post-lock
   snapshot for the capacity check, pricing and claim.

`cron-confirm-pending.ts` is the reference implementation; the same shape is in
`confirm-draft` / `guests` routes, the booking modify/cancel/settlement services,
`payment-reconciliation.ts`, `payment-link.ts` and the draft-cleanup in
`instrumentation.node.ts`. Skipping step 3 (acting on the pre-lock snapshot) is a
TOCTOU: a writer that blocks on the contended lock proceeds on stale
dates/guests after the current holder commits new ones.

## Capacity: who claims, who releases, under which lock

Capacity is **per lodge** ("beds available on date D at lodge L"; no path sums
across lodges). The lock landscape here is **deliberately mid-migration** and
therefore mixed — worth understanding before touching it:

- **Claims under the per-lodge lock** (the target state): `booking-create.ts`,
  `group-settlement.ts`, and `xero-inbound/invoice-paid-effects.ts` (which
  composes the per-lodge lock *and* the global lock — see below).
- **Claims still under the global lock (`1`)**: `confirm-pending-guests`.
- **Releases under the global lock (`1`)**: `booking-cancel.ts`,
  `internet-banking-payment-cron.ts`, `cron-quote-expiry-reminders.ts`,
  `cron-group-settlement-reaper.ts`.

Why the mix is currently safe: a **release** (freeing beds) can never overbook —
the worst case of a release not serialising against a claim is a momentarily
conservative capacity view that self-corrects. So converting release paths to the
per-lodge lock is a **throughput** change, not a correctness one *for capacity*.
(But see the credit caveat below — one release path also restores money.)

`invoice-paid-effects.ts` is the one intentional **two-lock composition**: it
keeps the global lock (for the sequential-webhook-processing guarantee its own
comment describes) *and* takes the booking's per-lodge lock before its
capacity-claiming branch, so it serialises correctly against per-lodge creators.

## Credit restoration: a money invariant that rides the capacity lock

`restoreCreditFromBooking` (`member-credit.ts`) restores a cancelled booking's
applied credit by inserting one `CANCELLATION_REFUND` row. It is **not
self-idempotent** — its exactly-once guarantee is the caller's status-guard held
under a shared lock. Today the two direct restore paths (`booking-cancel.ts` and
the internet-banking release cron) both take the **global lock (`1`)**, so they
serialise and only one row is ever written. The orphan-heal repair
(`orphaned-applied-credit-backfill.ts`) instead takes the **per-member credit
ledger lock** and re-derives an "already restored?" predicate
(`deriveOrphanedAppliedCreditFinding`: a `CANCELLATION_REFUND` for the booking
means it's handled), so it too never double-restores.

The important consequence for anyone changing these locks: **the credit-restore
exactly-once guarantee currently depends on all restore paths sharing the global
lock.** Moving a credit-restoring path off lock `1` (for example, converting the
IB release cron to a per-lodge lock for throughput) would let it run concurrently
with a `booking-cancel` of the same booking and **double-restore the credit** —
there is no DB-level guard (`MemberCredit` has only an index on
`sourceBookingId`, no unique constraint). This is why the per-lodge conversion of
the release crons was **not** done. Hardening `restoreCreditFromBooking` to be
idempotent independent of lock granularity is tracked in **issue #1636**; until
that lands, keep every credit-restoring path on the global lock.

## Rules of thumb when working here

- **Adding a capacity claim?** Take `acquireLodgeCapacityLock(tx, lodgeId)` and
  follow read-key → lock → re-read. Do not introduce a new capacity claim under
  the global lock.
- **Adding a member-night writer?** Take the global lock before the guard
  (`review-findings-contracts.test.ts` will hold you to it).
- **Touching credit restoration?** Do not move it off the global lock without
  first making `restoreCreditFromBooking` idempotent (#1636); a check-then-insert
  alone is not concurrency-safe across paths on different locks.
- **Composing two locks in one transaction?** Acquire them in a consistent
  global order everywhere to avoid deadlock (the processor that takes multiple
  per-lodge locks acquires them in sorted `lodgeId` order for exactly this
  reason).
