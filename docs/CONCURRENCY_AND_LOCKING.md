# Concurrency and advisory locking

How the app serialises the operations that would otherwise race — overbooking a
lodge, double-restoring a member's credit, two people holding the same night,
two runners generating one roster, a settle racing a reap. The primary
cross-row mechanisms here are **PostgreSQL transaction-scoped advisory locks**
(`pg_advisory_xact_lock(...)`): they are held for the life of the enclosing
transaction and released automatically on commit or rollback. Two narrow
`SELECT ... FOR UPDATE` protocols also exist and are inventoried below. All
writers additionally follow the status-guarded-claim rule described below.

This doc maps **which locks exist, what each one protects, how they interact,
and the ordering every writer must follow**. Read it before changing any lock
key, adding a capacity/credit/settlement write path, or converting a global lock
to a scoped one (or the reverse).

> Why advisory locks and not unique constraints? Several of these invariants are
> cross-row or cross-table (e.g. "a member can't hold two bookings covering the
> same night" spans `BookingGuest` → `Booking`), or need a **partial** unique
> index Prisma cannot express and `db:check-drift` would then reject. Where a
> DB constraint *can* carry the invariant it is preferred (and, since #1636, the
> credit-restore exactly-once guarantee IS a unique constraint — see below);
> where it can't, an advisory lock serialises the check-then-write instead.

## The two-tier protocol (#1881)

The multi-lodge migration split what used to be one club-wide lock into two
tiers. **Getting the tier — and the acquisition order — wrong re-opens the exact
money/capacity races the locks exist to prevent.**

### Tier 1 — per-lodge capacity claims

`acquireLodgeCapacityLock(tx, lodgeId)` (`capacity.ts`) serialises **bed/capacity
claims for ONE lodge**. Bookings at different lodges never contend, so two
members booking different lodges proceed in parallel. Every path that reads
occupancy and then claims a bed (create, confirm-from-draft, settle-to-CONFIRMED,
date/guest modification, waitlist confirm, the Internet-Banking capacity gate)
takes this lock keyed on the booking's own lodge.

### Tier 2 — global booking-status / money serialisation

`pg_advisory_xact_lock(1)` (the literal global lock) serialises **status
transitions and money side effects that must be mutually exclusive across the
whole booking regardless of lodge**: cancel, capture/settle, hold-release, the
group-settlement reaper, refunds, and credit restoration. These are not
per-lodge concerns — a cancel and a capture of the *same booking* must exclude
each other whatever lodge it is at — so they share the single global key.

### A writer that does BOTH takes BOTH — global first

Many writers do both tiers at once: a Stripe capture claims capacity **and**
moves money; a date modification reprices/refunds **and** re-checks capacity; a
quote-accept flips booking status **and** holds a bed. Every such writer:

1. takes the **global `lock(1)` FIRST**, then
2. takes the **per-lodge lock**.

The global-before-per-lodge order is fixed everywhere so composing the two can
never deadlock. Writers that compose several *same-family* locks (multiple
per-lodge locks, or multiple per-member locks) acquire them in **sorted key
order** for the same reason.

### Status-guarded claims (defense in depth)

Every status-transition write in the cluster is a **status-guarded
`updateMany`**, not a bare `update` by id:

```ts
const claimed = await tx.booking.updateMany({
  where: { id, status: <expected status(es)> },
  data: { status: <new status>, ... },
});
if (claimed.count === 0) { /* lost the claim — bail, no side effects */ }
```

Under the correct lock this is belt-and-braces (the under-lock re-read already
established the status), but it makes the "no clobber" guarantee **structural**
rather than purely lock-dependent: a writer that somehow slipped the lock still
cannot flip a booking a concurrent writer already moved.

## The lock families

All keys below are the argument(s) to `pg_advisory_xact_lock`. Two-argument keys
use `(namespace, subject)`; single-argument keys hash a descriptive string or
are the literal `1`.

| Lock | Key | Helper / where | Tier | Serialises |
| --- | --- | --- | --- | --- |
| **Global booking / money** | `1` (literal) | inline `tx.$executeRaw` | 2 | Booking-status + money side effects that must exclude across the whole booking regardless of lodge: cancel, capture/settle, hold-release, group-settlement reaper/settle/refund/organiser-cancel, refunds, credit restore. |
| **Per-lodge capacity** | `hashtextextended(<lodgeId>, 0)` | `acquireLodgeCapacityLock(tx, lodgeId)` (`capacity.ts`) | 1 | Capacity claims/checks for one lodge. |
| **Per-member night footprint** | `hashtext("booking-member-night"), hashtext(<memberId>)` | `lockBookingMemberNights(tx, guests)` (`booking-member-night-conflicts.ts`) | cross-lodge | Serialises the person-night guard ACROSS lodges (see below). |
| **Per-member credit ledger** | `hashtext("member-credit-ledger"), hashtext(<memberId>)` | `lockMemberCreditLedger(memberId, tx)` (`member-credit.ts`) | — | A member's credit-ledger balance operations (spend, negative-adjustment validation, orphan-restore repair, the Xero inbound applied-credit repair, and the F20 pre-payment-reduction applied-credit clamp `clampAppliedCreditToBookingPrice`, taken inside the modification transaction only when the booking carries applied credit). |
| **Member lifecycle** | `hashtext("member-lifecycle:<memberId>")` | inline (`member-lifecycle-actions.ts`, `nomination.ts` approval mapping, `admin-family-group-requests-service.ts`, `member-merge.ts`) | — | Archive/delete of one member; overwrite of one member by application-approval mapping (E10, #1936); linking/removing one member into/from a family group on admin request review; and **member merge** (dual-lock on master + loser, E11 #1937, see below). |
| **Membership application** | `hashtext(<application key>)` | `membershipApplicationLockKey` (`nomination.ts`) | — | State transitions of one membership application. |
| **Membership applicant** | `hashtext(<applicant-email key>)` | `membershipApplicationApplicantLockKey` (`nomination.ts`) | — | Per-email applicant dedup at submit time. |
| **Roster generation** | `hashtext("roster:<date>")` | inline (`admin-roster-service.ts`) | — | Roster generation for one calendar date. |
| **Config-transfer import** | `hashtext("config-transfer-import")` | `acquireConfigImportLock(tx)` (`config-transfer/apply.ts`) | — | Single-flights configuration-bundle apply. |
| **Membership subscription billing** | `hashtext("membership-subscription-billing:<seasonYear>")` | `confirmSubscriptionBillingPreview`, `reconcileSubscriptionBillingExceptions` (`membership-subscription-billing.ts`) | — | Annual/approval charge snapshot creation for one membership year; the #2148 refresh-reconciliation holds the same key so exception auto-resolution serialises with confirm and never resolves rows a concurrent confirm is regenerating. The #2161 operator family-marker writers (MARK/UNMARK on the subscription-billing route) deliberately take **no** advisory lock: they only insert/release a `FamilyGroupSeasonInvoiceMarker` row (single-active enforced by a partial unique index, so a concurrent double-mark is a benign no-op), and confirm re-derives suppression from the live marker rows under this same lock inside its transaction, so a mark landing mid-confirm either is seen by the in-tx re-preview or shifts the confirmation token — never a torn snapshot. |
| **Authoritative fee schedule** | `hashtext("fee-schedule:<domain>:<key>")` | `lockFeeSchedule` (`authoritative-fees.ts`) | — | Serialises effective-dated membership or entrance-fee schedule changes for one configured key. |
| **Member partner link** | sorted `hashtext("member-partner-link:<memberId>")` keys | `lockPartnerMembers` (`member-partner-link.ts`) | — | Serialises partner-link invariants across every member touched by a link; same-family keys are sorted. |
| **Xero member contact link (legacy key)** | `hashtext(<memberId>)` | short local-link transactions (`xero-contacts.ts`) | — | First-writer-wins local `Member.xeroContactId` linking after provider work. This legacy unnamespaced key is shared by both Xero contact-link writers; do not copy it for new domains. |
| **Backup run claim** | `hashtext("backup:run-lock")` | `claimBackupRun` (`backup-run.ts`, #2095) | — | Single-flights managed database backups across containers (nightly cron vs admin run-now). Held only for the milliseconds of the reap-stale → active-check → insert-RUNNING claim transaction; the `pg_dump`/upload pipeline runs entirely outside any transaction, so a crashed run can never wedge the lock (a dead RUNNING row is reaped by heartbeat age on the next claim). Single-lock holder; composes with no other family. The config-transfer pre-apply safety backup deliberately bypasses this claim (it must run inline; concurrent dumps are independent snapshots writing uniquely-named files). |

### Composition: application-approval mapping (E10, #1936)

The membership-application approval transaction is the one writer that composes
the application and member-lifecycle families. Its fixed acquisition order is:

1. `member-application:<applicationId>` (the existing approval lock), THEN
2. every mapped target's `member-lifecycle:<memberId>`, in **sorted key order**.

Counterpart analysis — no cycles are possible:

- Every other `member-lifecycle` holder is single-lock in that family:
  member archive/delete approval (`member-lifecycle-actions.ts`) locks exactly
  one member and takes no application lock; the admin family-group request
  review transactions (`admin-family-group-requests-service.ts`) lock exactly
  the one pre-existing member being linked into (or removed from) a group
  before writing `FamilyGroupMember` — required because a `FamilyGroupMember`
  insert does not bump `Member.updatedAt`, so only the lock (not the mapping
  preview token) can serialise it against the mapping approval's
  in-any-family-group collision guard. (The group-create *reject* transaction
  takes no member lock: it links nobody into a group.)
- No `member-lifecycle` holder ever acquires a `member-application` lock, so
  the application → member-lifecycle direction is one-way.
- Within the member-lifecycle family the approval acquires multiple keys in
  sorted order, matching the same-family rule above.

The F20 clamp inserts any required Xero deallocation outbox row before releasing
the member-credit lock. Provider GET/delete/recreate calls run later, outside the
transaction; ambiguous provider state fails to durable retry/manual review.
Allocation and deallocation handlers detect another RUNNING operation for the
same Payment. Separate runners can claim both rows before either check, so this
contention uses a dedicated transient result: each loser returns to PENDING
(never FAILED), and a later scan runs them without overlap. A post-recreate
verification (or next-run top-of-loop guard) mismatch that is explained purely by
Xero eventual consistency relative to the durable checkpoints — a just-deleted
allocation still listed, or a just-created recreate not yet listed — reuses that
same transient PENDING requeue (bounded, so persistent non-convergence still
lands FAILED) instead of failing terminal; only a mismatch no eventual-consistency
projection explains stays terminal. Provider-verified
local slice/link reconciliation retakes the member ledger lock.
The deallocation worker's first member-locked transaction records one durable
snapshot of desired applied cents plus all precise slices. Clamp, inbound repair,
and allocation planning query the deallocation fence under that same lock.
A fresh PENDING row fences inbound/clamp writers so stale provider truth cannot
undo the committed local target. Allocation/deallocation workers may pass it to
preserve queue order only while it has no snapshot/checkpoint; a manually
requeued checkpointed PENDING row remains fenced, as do RUNNING and any
provider-ambiguous failure states. Manual retry only CAS-requeues to PENDING;
the outbox claim is the sole authority that may execute provider calls.

Never-captured cancellation and Internet-Banking hold expiry acquire global
booking lock(1) first and the per-member credit-ledger lock second. While
holding both, they query for any non-complete applied-credit deallocation
before their first write. If one exists they defer the whole transition; a
later retry computes the clearing amount from provider-converged slices. The
paid/captured cancel (refund) path does not take the credit-ledger lock or this
fence: it restores credit from the payment mirror (mirror-based and capped) and
never sizes clearing from slices. Legacy inbound rows missing
those slices are repaired under the member-credit lock only when a unique
positive funding lot proves provenance. Slice reduction/deletion is therefore
working state, while the operation checkpoint/history and inactive/active
object-link history preserve the durable audit trail.

The first four are the **booking / capacity / credit cluster** — they interact,
and are where the ordering discipline matters. The remaining rows are
independent single-domain locks. Their namespaced keys do not intentionally
contend with the cluster or each other. The legacy Xero member-contact key is an
explicit exception: retain it only for its two current counterpart writers and
do not use unnamespaced `hashtext(<id>)` for new lock families.

### Narrow row-lock protocols

- `booking-create-promo.ts` locks the selected `PromoCode` row with `FOR UPDATE`
  before validating and consuming its use count. Booking creation has already
  taken the per-lodge capacity lock, so the current order is lodge -> promo row;
  no counterpart writer may take the promo row and then a lodge lock.
- `admin-bed-allocation.ts` locks the owning `LodgeRoom` row with `FOR UPDATE`
  before checking and changing one room's bunk-group membership. This protocol
  is independent of the booking/capacity/credit lock cluster.

Do not add or compose a row lock without updating this inventory and documenting
its order against every advisory- and row-lock counterpart.

### Member merge — dual member-lifecycle lock (E11 #1937)

`executeMemberMerge` (`member-merge.ts`) is the only writer that holds **two**
`member-lifecycle:<memberId>` advisory locks at once — one for the master, one
for the loser. Both are acquired at the very top of the single merge transaction
in **sorted id order** (`[masterId, loserId].sort()`, smaller id first) so a
merge and its mirror (a merge started from the other direction, or a concurrent
archive/delete of either member) can never deadlock. Because the keys share the
`member-lifecycle:` namespace with `member-lifecycle-actions.ts`, a merge also
mutually excludes any archive or delete of either the master or the loser.

Inside the locks the merge re-reads both members, re-runs the full guard matrix,
and re-verifies the HMAC preview token (which bakes in both `updatedAt` values)
before any write, so a stale preview or a concurrent edit fails with a 409
instead of merging against changed state. There are **no Xero API calls** in or
after the transaction — the loser's Xero teardown is DB-only (deactivate
contact-identity `XeroObjectLink` rows and re-point the active
`ENTRANCE_FEE_INVOICE` link to the master); the loser's Xero contact is left for
manual clean-up.

The merge transaction runs with an extended interactive-transaction window
(`timeout: 120s`, `maxWait: 10s`): re-pointing 70+ relations takes hundreds of
sequential round-trips on a heavy member, and the dual advisory lock already
serialises every competing lifecycle writer, so the long window cannot admit a
concurrent conflicting write.

## The disciplines, by writer class

### Capacity claim → per-lodge lock, read-key → lock → re-read

The per-lodge lock key needs the booking's `lodgeId`, which you only know after
reading the row — so these paths cannot lock before their first read. The safe
pattern is:

1. Read only `{ lodgeId }` (plus any cheap early-bail fields). `lodgeId` is
   immutable, so keying the lock from this read is always safe.
2. `acquireLodgeCapacityLock(tx, lodgeId)` (after `lock(1)` if the writer also
   moves money — see below).
3. **Re-read the full row under the lock** and consume only that post-lock
   snapshot for the capacity check, pricing and claim.

`cron-confirm-pending.ts` is the reference implementation; the same shape is in
`booking-create.ts`, `payment-reconciliation.ts`, `group-settlement.ts`
(`commitChildrenToConfirmed`, keyed on each child's own lodge in sorted order),
the confirm-pending-guests / waitlist-confirm / switch-to-internet-banking
routes, the booking modify/cancel/settlement services, and
`xero-inbound/invoice-paid-effects.ts`. Skipping step 3 (acting on the pre-lock
snapshot) is a TOCTOU.

The admin exclusive whole-lodge hold route follows the same rule even though
the hold flag itself is row-scoped: it reads only immutable `lodgeId`, takes the
per-lodge lock, then re-reads status, hold state and dates. Both set-time
conflict queries and their audit metadata consume that post-lock snapshot, so a
concurrent date move cannot make the hold apply to one range while reporting
conflicts for an older range. Its status-guarded SET remains necessary because
cancel writers use the disjoint global lock and may still race the row update.

### Global-cohort money / status transition → global `lock(1)`

Cancel (`booking-cancel.ts`), Stripe capture and the capacity-failed void
(`payment-reconciliation.ts`), the Internet-Banking hold-expiry release
(`internet-banking-payment-cron.ts`), the quote hold-release crons
(`cron-quote-expiry-reminders.ts`), and the whole group-settlement lifecycle —
settle (`group-settlement.ts` `settleConfirmedChildrenAndNotify`), the reaper
(`cron-group-settlement-reaper.ts`), `markGroupSettlementIntentFailed` /
`markGroupSettlementIntentRefunded`, and the organiser-cancel FAILED claim
(`group-cancel.ts`) — **all take `lock(1)`**, so any two operations on the same
booking or settlement mutually exclude. The group-settlement paths in particular
MUST share `lock(1)`: before #1881 the settle path took a per-lodge (default
lodge) key while the reaper took `lock(1)`, so a settle could race a reap into an
inconsistent settlement/child state. `markGroupSettlementIntentFailed` also
initially skipped the lock; #1881 wrapped it in `lock(1)` to match this claim, so
it can no longer execute between a multi-statement settle transaction's own
statements. Note the FAILED mark and the settle path both leave `FAILED` OUT of
their status-guard `notIn` set BY DESIGN: a settlement marked `FAILED` by a
`payment_failed`/`payment_intent.canceled` webhook whose money is then genuinely
captured (`payment_intent.succeeded` → settle) must still become `SUCCEEDED`, so
settle legitimately overwrites `FAILED` → `SUCCEEDED`. `lock(1)` guarantees the
two run whole-before-whole; it is not a veto on that transition.

`lock(1)` also serialises the duplicate-capture adjudication (#1992). When a
Stripe success arrives for an already-PAID booking, `markBookingPaymentSucceeded`
refunds the arriving capture only if it is a DIFFERENT intent from a captured
PRIMARY transaction still holding net cash, AND no duplicate-capture refund
operation (`duplicate_capture_<bookingId>_<pi>`) already exists for the booking
against another intent. That check-then-enqueue is race-free only because every
caller runs it under `lock(1)`: interleaved webhook replays of BOTH captures
would otherwise refund both sides and settle the booking at zero net cash. The
refund itself follows the #1349 enqueue-then-execute shape — the durable
operation (with the slice pinned to the duplicate's own transaction) commits
with the detection, and the Stripe refund executes after commit under the
shared `duplicate_capture_refund_<bookingId>_<pi>` key prefix the recovery cron
replays. Relatedly, the auto-charge cron's pre-charge sweep that cancels
superseded /pay link intents (#1992 Option 1) is a plain Stripe call strictly
OUTSIDE any transaction, after the claim commit: the claim's link revocation
under the lodge lock freezes the set of link intents, and the sweep excludes the
cron's own `pending_hold_auto_charge` transactions because Stripe's shared
`pending_charge_<bookingId>` idempotency key re-returns a prior run's intent.

Organiser cancellation adds a durable veto before it releases the lock:
`group-cancel.ts` writes `GroupBooking.status = CANCELLED` under `lock(1)`
before voiding/refunding Stripe or cancelling children. Settlement apply
re-reads that group status under the same lock and returns `cancelled` without
writing Payments or promoting children. Therefore either settlement wins first
and cancellation observes `SUCCEEDED`/`PAID` and refunds it, or cancellation
wins first and every later capture is refused; a late Stripe capture follows
the deterministic superseded-intent refund path, while a paid Xero invoice is
left unapplied and raises an operator refund alert. Provider calls remain
outside the transaction. Per-child cancellation is also a status-guarded claim,
so a stale child snapshot can never overwrite a terminal transition.

### Writer doing both → `lock(1)` first, then per-lodge

The Stripe capture (`markBookingPaymentSucceeded`), the confirm-pending-guests
zero-dollar and charge branches, the waitlist-confirm $0 PAID claim, the
switch-to-internet-banking hold, the quote-accept conversion
(`approveBookingRequest`), and every booking modification service
(batch/date/guest-removal) take **`lock(1)` first, then the per-lodge lock**.
`xero-inbound/invoice-paid-effects.ts` is the in-tree precedent for this
composition.

Generic quote acceptance pre-reads only the held booking's immutable concrete
`lodgeId`, then takes global -> that lodge and fully re-reads both request and
hold. It rejects an explicit request/hold lodge mismatch and carries the same
concrete lodge into policy and email context. A null request lodge is never
re-resolved through a default that may have changed after hold creation.

Both held-conversion claims fence optimistically on the request's integer
`BookingRequest.version` (`version: request.version` in the claim `updateMany`
WHERE, mirrored by a JS re-read comparison), not on `updatedAt` (#1923). Every
mutating write of a `BookingRequest` bumps `version: { increment: 1 }`, so a
writer that lands after the converter's locked re-read invalidates the stale
claim. `updatedAt` is `TIMESTAMP(3)` (millisecond precision): two writes in the
same millisecond share a timestamp and would silently defeat a `updatedAt` CAS,
which the integer counter cannot.

School approval has two deliberately different branches. Fresh-create is a
capacity-only admission and takes only the per-lodge lock. Held-reuse converts
an existing AWAITING_REVIEW booking that cancellation/release may claim, so it
takes **global first, then per-lodge**, re-reads the request and hold under both,
and uses a status-guarded `AWAITING_REVIEW -> CONFIRMED` claim before side
effects. A lost claim aborts the transaction.

The linked provisional-child sweep after a parent cancellation follows the
same order. It uses the child's immutable `lodgeId` only to select the lock,
then re-reads the child and conditionally claims `PENDING -> CANCELLED` under
both locks. `cron-confirm-pending` shares the per-lodge lock, so either the
cancel wins and alone runs cancellation side effects, or the cron's confirmed /
charged state survives and the stale sweep runs no side effect.

`switch-to-internet-banking` also recomputes both the locked booking price and
the authoritative `BOOKING_APPLIED` credit aggregate after acquiring global,
lodge, then `lockMemberCreditLedger(memberId)` locks in that order;
the IB payment mirror must never mix a pre-lock price with post-lock credit (or
vice versa). Waitlist offer confirmation resolves only the immutable lodge key
before locking, then re-reads status and expiry under the lodge lock and fuses
those checks with its update. The expiry reaper returns side effects only for
rows whose guarded revert/cancel actually claimed one row.

Group-settlement initiation selects/rejects `GroupBooking.CANCELLED` at entry
and re-checks the durable fence under global `lock(1)` before taking child-lodge
locks or proceeding to either the Stripe or Internet Banking provider path. A
cancelled group cannot mint a fresh PaymentIntent or enqueue a new combined
invoice.

Combined Xero invoice cancellation is a durable compensating workflow. Once an
invoice id is persisted, the same global cancellation fence atomically enqueues
a `GROUP_SETTLEMENT_INVOICE_VOID` outbox UPDATE with an invoice-specific
correlation/idempotency key; this remains replayable even when the original
invoice CREATE operation already succeeded. The create worker does the same if
cancellation wins while `createInvoices` is in flight. To close the otherwise
unavoidable last-check-to-email gap, only the single bounded Xero `emailInvoice`
call spans `lock(1)`: cancellation either commits first (email suppressed, VOID
queued) or waits until the email call finishes and then commits its VOID debt.
No invoice construction, contact lookup, create, or VOID provider call is held
inside that transaction.

The opt-in PostgreSQL race harness is wired into the migration-drift job against
its own `postgres:16-alpine` service on loopback port `55442`, database
`concurrency_race_1881`. Its dedicated-URL, loopback, high-port, and name-marker
guards remain mandatory; ordinary application databases are never valid targets.
Alongside scratch-table lock/CAS probes, the harness seeds the migrated
application schema and races the real group-settlement failure writer against a
locked PaymentIntent re-point, proving a stale webhook cannot fail the new
settlement attempt.

### Member-night guard → per-member lock, ACROSS lodges

"A member cannot hold two bookings covering the same night" is enforced by
`assertNoBookingMemberNightConflicts` (`booking-member-night-conflicts.ts`). This
invariant **spans lodges** — the guard query deliberately ignores `lodgeId` — but
capacity claims serialise only per lodge, so two concurrent writers for the same
member at *different* lodges hold different capacity locks and would both pass
the guard. The authoritative assert therefore takes a **per-member advisory lock
for every member-linked guest, in sorted `memberId` order, BEFORE reading**
(`lockBookingMemberNights`). Callers take it after their per-lodge lock, giving a
consistent lodge → member-night order. The advisory (non-authoritative)
`findBookingMemberNightConflicts` pre-check (used by the request-linking UI)
deliberately does NOT lock. `review-findings-contracts.test.ts` freezes that
every same-transaction member-linked guest writer takes the per-lodge lock before
the guard, and that the guard self-takes the per-member lock.

## Capacity: who claims, who releases, under which lock

Capacity is **per lodge** ("beds available on date D at lodge L"; no path sums
across lodges). Claims take the per-lodge lock keyed on the booking's own lodge.
Releases (freeing beds) can never overbook — the worst case of a release not
serialising against a claim is a momentarily conservative capacity view that
self-corrects — but a release that also flips booking status or moves money
(cancel, hold-expiry) takes `lock(1)` for the status/money reason, not the
capacity reason.

## Credit restoration: exactly-once is now STRUCTURAL (#1636)

`restoreCreditFromBooking` (`member-credit.ts`) restores a cancelled booking's
applied credit by inserting one `CANCELLATION_REFUND` row. As of **#1636 (landed)**
that row carries a **nullable-unique `restoredFromBookingId`**, and the insert
goes through `createMany({ skipDuplicates: true })` (`INSERT ... ON CONFLICT DO
NOTHING`). So **at most one restore row per booking can exist REGARDLESS of the
caller's lock granularity** — a duplicate inserts nothing and returns 0, never a
second credit, and never aborts the caller's transaction. This removed the old
cross-path dependence on all restore callers sharing `lock(1)`: moving a
credit-restoring path to a different lock can no longer double a restore.

Each restore caller still runs under `lock(1)` and its status-guarded claim
remains the *primary* single-flight (the claim, not a description string,
guarantees the surrounding side effects run once); the unique key is the
structural backstop underneath it. The Xero inbound applied-credit repair
(`xero-inbound/credit-note-repairs.ts`) takes the **per-member credit ledger
lock** (not `lock(1)`) so its `BOOKING_APPLIED` writes mutually exclude the
credit spend engine, which takes the same key. The orphan-heal repair
(`orphaned-applied-credit-backfill.ts`) also takes the per-member credit ledger
lock and re-derives an "already restored?" predicate.

## Rules of thumb when working here

- **Adding a capacity claim?** Take `acquireLodgeCapacityLock(tx, lodgeId)` on
  the booking's own lodge and follow read-key → lock → re-read. If the same
  transaction also performs a global-cohort lifecycle or settlement-money
  transition, take `lock(1)` FIRST.
- **Adding a global-cohort transition (cancel/capture/settle/refund/hold-release)?**
  Take `lock(1)` and status-guard the write
  (`updateMany({ where: { id, status } })`, bail on count 0). A capacity-only
  admission/status claim follows the per-lodge writer matrix instead; do not
  infer its tier from the fact that it changes a status column.
- **Adding a member-night writer?** It runs the guard, which self-takes the
  per-member lock; just make sure it calls `assertNoBookingMemberNightConflicts`
  inside the transaction after any per-lodge lock
  (`review-findings-contracts.test.ts` holds you to it).
- **Touching credit restoration?** The exactly-once guarantee is structural
  (`restoredFromBookingId` unique, #1636); keep the status-guarded claim as the
  primary single-flight and do not remove the unique key.
- **Touching group settlement?** Every settlement-status transition
  (settle/reap/fail/refund/organiser-cancel) must stay on `lock(1)` so they all
  serialise; only the per-child capacity *claim* (`commitChildrenToConfirmed`)
  uses per-lodge locks.
- **Composing two locks in one transaction?** Global `lock(1)` before any
  per-lodge lock; multiple same-family locks in sorted key order.
