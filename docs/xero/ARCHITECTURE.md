# Xero Subsystem Architecture

This document maps the operational Xero integration: the ~50 `xero-*` modules
in `src/lib`, the database tables they own, the API routes and cron tasks that
drive them, and the dataflow through the three main flows (outbound documents,
inbound reconciliation, repair/hardening). It complements the repo-wide
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) ("Xero integration layers"), which
lists the module boundaries; this document explains how the pieces move at
runtime.

Source of truth for behavior is always the code. This map was produced by the
2026-07 quality wave (issue #1128) and reflects the codebase at that date.

## Membership subscription invoices

`MEMBERSHIP_SUBSCRIPTION_INVOICE` is an outbound outbox discriminator anchored
on `MembershipSubscriptionCharge`. Its correlation key is charge-stable.
Dispatch resolves the snapshotted recipient and uses the account/item mapping
frozen at confirmation,
then searches by the immutable `MEMSUB-*` reference. Zero matches creates an
AUTHORISED ACCREC invoice with inclusive line amounts and `OUTPUT2`; one exact
contact/account/item/amount/due-interval/type/state match is adopted. Only `AUTHORISED` is
adoptable; draft, submitted, paid, voided, and deleted invoices conflict rather
than being emailed. Duplicates or a mismatch set
the charge to `CONFLICT` without calling an Xero update endpoint.

Creation/adoption is committed locally (charge, covered subscriptions, canonical
Xero link) before `emailInvoice`. If email fails the operation is `PARTIAL` and
the charge is `EMAIL_FAILED`. Retrying enqueues the same charge key; the stored
`xeroInvoiceId` makes dispatch skip lookup/create and retry only email with its
stable email idempotency key. Crash recovery follows that same path.

The frozen recipient name/email are audit evidence. Dispatch deliberately uses
that recipient member's current Xero contact identity and Xero contact email.
Inbound invoice changes are joined back through charge coverage so a shared
family invoice updates recipient and non-recipient subscriptions together.

## Bird's-eye dataflow

```mermaid
flowchart LR
    subgraph Triggers
        BIZ[Booking / payment / refund /\nmembership flows]
        WH[Xero webhook\n/api/webhooks/xero]
        CRON[Cron\n/api/cron/xero?task=...]
        ADMIN[Admin UI\n/api/admin/xero/*]
        CLI[scripts/xero-booking-repair.ts]
    end

    subgraph Ledger [Reconciliation ledger &#40;Postgres&#41;]
        OPS[(XeroSyncOperation)]
        LINKS[(XeroObjectLink)]
        EVENTS[(XeroInboundEvent)]
        CURSORS[(XeroSyncCursor)]
        CACHES[(XeroContactCache /\nGroupCache / AdminCache)]
    end

    subgraph Workers
        OUTBOX[xero-operation-outbox\nprocessQueuedXeroOutboxOperations]
        RETRIES[xero-operation-queue\nprocessQueuedXeroOperationRetries]
        INBOUND[xero-inbound-reconciliation\nrunXeroInboundReconciliationCycle]
        REPAIR[xero-booking-repair\nrunBookingXeroRepair]
        HARDEN[xero-hardening\nbackfill / cleanup / report]
    end

    subgraph Infra [Infrastructure]
        CLIENT[xero-api-client\ncallXeroApi + withXeroRetry]
        TOKENS[xero-token-store\nencrypted tokens + refresh lease]
        OAUTH[xero-oauth\nconsent / callback / disconnect]
    end

    XERO[(Xero API)]

    BIZ -- enqueue + kick --> OPS
    WH -- store event --> EVENTS
    WH -- bounded kick --> INBOUND
    CRON --> OUTBOX & RETRIES & INBOUND & HARDEN
    ADMIN --> OPS & EVENTS & REPAIR
    CLI --> REPAIR

    OUTBOX -- claim PENDING --> OPS
    RETRIES -- claim REQUEUE --> OPS
    INBOUND -- claim RECEIVED/FAILED --> EVENTS
    INBOUND -- cursors --> CURSORS
    REPAIR -- plan/apply --> OPS

    OUTBOX & INBOUND & REPAIR & HARDEN --> CLIENT
    CLIENT --> TOKENS
    OAUTH --> TOKENS
    CLIENT <--> XERO
    XERO -- webhooks --> WH

    OUTBOX & INBOUND --> LINKS
    INBOUND --> CACHES
```

Two design rules shape everything below:

- **Every Xero side effect is a ledger row.** All outbound writes and inbound
  reconciliations run inside a `XeroSyncOperation` (started/completed/failed
  via `xero-sync.ts`), and every created/discovered Xero object is linked to a
  local record through `XeroObjectLink`. The admin diagnostics, health
  snapshots, repair tooling, and hardening reports are all queries over this
  ledger.
- **Provider calls stay out of business transactions.** Business flows never
  call Xero inline. They enqueue an outbox operation inside their own
  transaction and then *kick* the worker after commit
  (`kickQueuedXeroOutboxOperationsIfConnected`, ~20 call sites). Cron sweeps
  whatever the kicks missed.

## Module map

`src/lib/xero.ts` is a compatibility facade (re-exports only, no logic) for
external callers. New code should import the focused module. The subsystem's
own `src/lib/xero-*` modules must import the source domain module directly, not
the facade — an `eslint.config.mjs` `no-restricted-imports` override enforces
this (#1208). Shared JSON-guard micro-helpers (`asRecord`/`readString`/
`readNumber`) live in `xero-json`. The subsystem groups as:

### Infrastructure

| Module | Owns |
| --- | --- |
| `xero-config` | Reads/validates `XERO_CLIENT_ID`/`SECRET`/`REDIRECT_URI`/`ENCRYPTION_KEY` for the operational connection. |
| `xero-oauth` | Consent URL, OAuth callback (`handleXeroCallback`), client construction, disconnect (revoke + clear tokens). |
| `xero-oauth-state` | CSRF state cookie for the OAuth round-trip. |
| `xero-token-store` | AES-encrypted token persistence (`XeroToken` row), connection status, and the **refresh lease** (`claimXeroTokenRefreshLease`) so concurrent serverless instances don't double-refresh; losers wait for the lease deadline and re-read. |
| `xero-api-client` | `getAuthenticatedXeroClient` (refreshes under lease), `callXeroApi` (meters every call into `XeroApiUsageDaily`/`XeroApiUsageEvent`, observes the daily budget and process-local rate-limit cool-downs), `withXeroRetry` (in-process retry for 429/5xx/408), `XeroDailyLimitError`, `XeroTransientOutageError`. |
| `xero-api-usage` | Daily budget constant and usage recording/summary. |
| `xero-api-errors`, `xero-error-shape` | Error classification helpers (status code, body message, headers). |
| `xero-error-alert` | Ops email on sync errors, deduplicated to one per hour via `EmailLog`. |
| `xero-links`, `xero-record-links`, `xero-record-types` | Deep links into the Xero UI and into local admin pages; shared record-activity types. |
| `xero-feature-flags` | `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH`, `XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS`, `XERO_ENABLE_AUTOLOAD_XERO_CONTACT_GROUPS`. |
| `xero-organisation` | Cached financial-year-end month of the connected org. |

### Reconciliation ledger core

| Module | Owns |
| --- | --- |
| `xero-sync` | The ledger primitives: `startXeroSyncOperation` / `completeXeroSyncOperation` / `failXeroSyncOperation`, payload redaction + hashing, `buildXeroIdempotencyKey`, `upsertXeroObjectLink` (enforces single-active canonical links for Member CONTACT, Payment PRIMARY_INVOICE, MemberSubscription SUBSCRIPTION_INVOICE), `recordXeroInboundEvent`. |
| `xero-sync-cursors` | `XeroSyncCursor` read/write for incremental syncs, plus throttling helpers. |
| `xero-stale-operations` | Filters/counters for operations stuck in RUNNING and inbound events stuck in PROCESSING (feeds cron health and the admin reset/replay actions). |

### Outbound document pipeline

| Module | Owns |
| --- | --- |
| `xero-operation-outbox` | `enqueueXero*Operation` (12 queue types) and the worker `processQueuedXeroOutboxOperations` (scans the indexed `queueType` column via `XERO_OUTBOX_QUEUE_TYPES`); also WAITING_PAYMENT release/reap for supplementary invoices. |
| `xero-operation-outbox-payload` | The 12 queue-type constants (plus the `XERO_OUTBOX_QUEUE_TYPES` list the pending scan filters on), payload schemas, and payload→expected-operation mapping used to claim rows safely. |
| `xero-operation-retry` | `retryXeroSyncOperation`: immediate replay of a failed operation (admin "Retry"), including contact-payload rebuild for member contact ops. |
| `xero-operation-queue` | Background replay: a REQUEUE `XeroSyncOperation` wraps the original id; `processQueuedXeroOperationRetries` claims and executes them via `retryXeroSyncOperation`. |
| `xero-operation-claim` | The shared `claimXeroSyncOperationToRunning(id, guard)` single-flight (#1272 part 2): one conditional `updateMany` that flips a PENDING row to RUNNING (with the four error/timestamp resets) only when `count === 1`. Both the outbox scan and the retry scan delegate their claim to it; only the caller's guard predicate differs. |
| `xero-booking-invoice-queue` | Thin helper: enqueue booking invoice + immediate kick, for callers that want one line. |
| `xero-booking-edit-settlement` | Classifies an admin booking edit into the right financial follow-up (update invoice / supplementary invoice / credit note) and queues it. |

### Financial document builders (called only by the outbox worker and repair)

| Module | Owns |
| --- | --- |
| `xero-booking-invoices` | Primary booking invoice create/update (`buildInvoiceLineItems`). |
| `xero-invoice-payments` | Recording Stripe payments against invoices and Stripe refunds as credit-note payments. |
| `xero-credit-notes` | Refund credit notes, unapplied (account-credit) credit notes, allocation to invoices. Stripe refunds settle **per delta** (#1162): a payment refunded in several steps gets one credit note per uncovered delta, keyed on a cumulative refunded-cents watermark; non-Stripe refunds keep one note per payment. |
| `xero-supplementary-invoices` | Positive booking-modification delta invoices. |
| `xero-modification-credit-notes` | Negative booking-modification credit notes. |
| `xero-entrance-fee-invoices` | One-off entrance-fee invoices per age tier. |
| `xero-group-settlement-invoices` | Combined ORGANISER_PAYS internet-banking invoice across joiner bookings. |
| `xero-invoice-helpers` | Shared date/allocation helpers for the six modules above. |
| `xero-mappings` | Account-code / item-code resolution from `XeroAccountMapping`/`XeroItemCodeMapping` (with legacy fallbacks), entrance-fee categorisation and idempotency keys. |

### Contacts and membership

| Module | Owns |
| --- | --- |
| `xero-contacts` | `findOrCreateXeroContact`, contact create/update, name normalisation/matching, and `retryXeroWriteWithContactRepair` (invoice writes retry once after repairing a stale contact link). |
| `xero-contact-cache` | `XeroContactCache` + per-contact group-membership cache primitives (no dependency on CRUD/bulk flows). |
| `xero-contact-groups` | Contact-group cache refresh, cache-backed reads, managed age-tier group sync. |
| `xero-bulk-contact-sync` | Cursor-driven incremental contact refresh from Xero (`syncContactsFromXero`). |
| `xero-member-import` | Creates local members from cached contacts in mapped groups. |
| `xero-duplicate-contacts`, `xero-contact-link-mismatches`, `xero-contact-sync` | Admin diagnostics: duplicate detection, link-mismatch snapshots, contact update payload builders. |
| `xero-membership-sync` | Subscription status per season derived from Xero invoices; incremental `refreshAllMembershipStatuses` driver. |

### Repair, hardening, admin

| Module | Owns |
| --- | --- |
| `xero-inbound-reconciliation` | Stored-event worker + per-entity reconcilers + incremental cursor reconciliation (see Flow 2). Split into cohesive `xero-inbound/*` sub-modules (#1208 item 1 / #1270, entry re-exports the public surface); see refactor item 1 for the module map. |
| `xero-booking-repair` | Booking-vs-Xero audit and self-repair (see Flow 3). CLI entry: `scripts/xero-booking-repair.ts`. Split into cohesive `xero-booking-repair-*` sub-modules (#1208 item 2, entry re-exports the public surface); see refactor item 2 for the module map. |
| `xero-hardening` | Historical `XeroObjectLink` backfill, stale canonical-link cleanup, the emailed reconciliation report, repeated-failure alerting. Split into cohesive `xero-hardening-*` sub-modules (#1208 item 5, entry re-exports the public surface); see refactor item 5 for the module map. |
| `xero-invoice-rounding-audit` | Read-only diagnostic that replays the pre-#1231 line maths in integer cents to flag issued invoices that would have carried the #1163 rounding drift, across **both** builder callers — per-booking invoices (`Payment.xeroInvoiceId`) and group-settlement invoices (`GroupBookingSettlement.xeroInvoiceId`). Makes **no** live-provider calls and mutates nothing (only `booking.findMany` + `groupBookingSettlement.findMany`). CLI entry: `scripts/audit-xero-invoice-rounding.ts`. See "Historical rounding-drift audit" below. |
| `xero-cron-runner` | Maps the 7 cron tasks to the workers above, records `CronJobRun` rows, gates on module + connection. |
| `xero-admin-failures`, `xero-admin-health`, `xero-record-activity`, `xero-admin-cache` | Admin overviews: failed-operation triage states, missing-invoice/missing-credit-note health snapshot, per-record activity timeline, cached chart-of-accounts/items. |

### HTTP surface

- `POST /api/webhooks/xero` — HMAC-verified event intake (Flow 2).
- `POST /api/cron/xero?task=memberships|outbox|retries|inbound|backfill|link-cleanup|report|all`
  — `CRON_SECRET`-gated; `all` runs the tasks in that order; `backfill` also
  runs `link-cleanup` by default. Tasks needing a connection are skipped (and
  recorded as SKIPPED) when Xero is disconnected or the `xeroIntegration`
  module is off.
- ~38 admin routes under `/api/admin/xero/**` and `/api/admin/members/[id]/xero-*`
  — OAuth connect/callback/disconnect, status/health/usage, operations list +
  retry/requeue/resolve/mark-non-replayable/reset-stale-running, inbound-events
  list + replay, contact tooling (search/import/sync/duplicates/mismatches),
  mappings, record activity.

## Data model

| Table | Role |
| --- | --- |
| `XeroToken` | Single-row encrypted OAuth token set + `refreshInProgressUntil` lease. |
| `XeroSyncOperation` | The ledger. `direction` INBOUND/OUTBOUND, `entityType`, `operationType`, optional `localModel`/`localId`, `idempotencyKey`, `correlationKey`, `replayable`, error fields, redacted request/response payloads, resulting Xero object identity, manual-resolution override fields, and `queueType` (a denormalized, indexed copy of `requestPayload.queueType` set at enqueue — canonical value still lives in the payload; #1271). **Status machine:** `PENDING → RUNNING → SUCCEEDED | FAILED`, plus `WAITING_PAYMENT → PENDING` for supplementary invoices held until their Stripe payment settles. Claims are optimistic `updateMany` transitions, so concurrent workers cannot double-run a row. |
| `XeroObjectLink` | Local record ⇄ Xero object links with a `role` (e.g. `PRIMARY_INVOICE`, `REFUND_CREDIT_NOTE`, `CONTACT`, `ENTRANCE_FEE_INVOICE`) and `active` flag; unique on (local, xero, role). Canonical single-active scopes are enforced on upsert. |
| `XeroInboundEvent` | Stored webhook/admin events. **Status machine:** `RECEIVED → PROCESSING → PROCESSED | FAILED` (FAILED retried after a backoff; stale PROCESSING is operator-replayable). Unique `correlationKey` makes webhook delivery idempotent. |
| `ProcessedWebhookEvent` | Provider-scoped processing dedupe (`source`+`eventId` unique); the inbound worker claims a row before reconciling and releases it on failure. |
| `XeroSyncCursor` | Incremental checkpoints per (`resourceType`, `scope`) for contact/membership/invoice reconciliation. |
| `XeroContactCache`, `XeroContactGroupCache`, `XeroContactGroupMembershipCache` | Local snapshots of Xero contacts and group memberships (feed admin tooling, member import, group sync). |
| `XeroApiUsageDaily`, `XeroApiUsageEvent` | Metered API usage vs. the daily budget; rate-limit hit tracking. |
| `XeroAdminCache` | TTL cache of chart-of-accounts and items per tenant. |
| `XeroAccountMapping`, `XeroItemCodeMapping` | Operator-configured account/item code mappings resolved by `xero-mappings`. |

## Flow 1 — Outbound financial documents (the outbox)

Business flows that create money artefacts (booking paid, refund approved,
modification settled, membership cancellation approved, group settlement
raised, entrance fee due) enqueue an operation and kick the worker. Nothing
talks to Xero inside a business transaction.

```mermaid
sequenceDiagram
    autonumber
    participant BIZ as Business flow<br/>(booking-create, stripe-webhook-service,<br/>booking-cancel, refund admin, ...)
    participant OB as xero-operation-outbox
    participant DB as Postgres<br/>(XeroSyncOperation / XeroObjectLink)
    participant DOM as Document module<br/>(xero-booking-invoices, xero-credit-notes, ...)
    participant CT as xero-contacts
    participant API as xero-api-client
    participant XERO as Xero

    BIZ->>OB: enqueueXero*Operation(...)
    OB->>DB: existing-link / duplicate checks,<br/>INSERT op (PENDING or WAITING_PAYMENT,<br/>requestPayload.queueType, idempotency key)
    BIZ--)OB: kickQueuedXeroOutboxOperationsIfConnected({limit:1})<br/>(after commit; cron ?task=outbox sweeps the rest)

    Note over OB: Supplementary invoices held as WAITING_PAYMENT are released<br/>to PENDING by stripe-webhook-service when the payment settles;<br/>reapStaleWaitingPaymentXeroOutboxOperations fails them after 14 days.

    OB->>DB: claim: updateMany(id, status=PENDING,<br/>expected entity/operation) → RUNNING
    OB->>DOM: dispatch on queueType (12 types)
    DOM->>CT: findOrCreateXeroContact(member)
    CT->>API: callXeroApi(withXeroRetry(...))
    API->>XERO: create/search contact
    DOM->>API: create invoice / credit note / allocation<br/>(retryXeroWriteWithContactRepair on stale contact)
    API->>XERO: POST document
    XERO-->>DOM: document id / number
    opt Stripe already settled
        DOM->>XERO: record payment against invoice /<br/>credit-note payment for refunds
    end
    DOM->>DB: completeXeroSyncOperation(SUCCEEDED,<br/>redacted response, upsert XeroObjectLinks)
    alt failure
        DOM->>DB: failXeroSyncOperation(FAILED + error code/message)
        Note over DB: surfaced in admin failures overview;<br/>replayed via retry/requeue (below) or repair (Flow 3)
    end
```

The 12 queue types: entrance fee, booking invoice, booking invoice update,
refund credit note, account credit note, supplementary invoice, modification
credit note, modification account credit note, credit-note allocation,
membership-cancellation credit note, membership-cancellation contact update,
group-settlement invoice.

**Retry taxonomy** (each layer is distinct — do not conflate when changing):

1. **Transport** — `withXeroRetry` retries 429/5xx/408 in-process with backoff;
   `callXeroApi` meters usage and trips process-local cool-downs
   (`XeroDailyLimitError`, `XeroTransientOutageError`).
2. **Stale contact repair** — `retryXeroWriteWithContactRepair` repairs the
   member↔contact link once and retries the write.
3. **Operation replay** — a FAILED ledger row is never auto-retried by the
   outbox loop (it only claims PENDING). Admins either replay immediately
   (`retryXeroSyncOperation`) or queue a background REQUEUE wrapper
   (`enqueueXeroSyncOperationRetry` → `processQueuedXeroOperationRetries`,
   cron `?task=retries`).
4. **Inbound event retry** — FAILED `XeroInboundEvent` rows are re-swept after
   `XERO_INBOUND_FAILED_RETRY_BACKOFF_MS`; stale PROCESSING rows are
   operator-replayable.

## Flow 2 — Inbound reconciliation (webhooks + incremental cursors)

Xero pushes CONTACT and INVOICE events; the webhook stores them and returns
fast. Reconciliation happens in a bounded worker kicked after the response and
swept by cron. Internet-banking settlement rides this flow: when an invoice is
paid in Xero **with cash evidence** (`amountPaid` > 0, falling back to actual
payment records; operator-applied overpayments/prepayments count), the
matching local payments/bookings are flipped here. A PAID event produced by
credit-note allocation — the app's own invoice-clearing notes do exactly that
on every unpaid-IB cancellation — settles nothing (#1435): identifiers are
stamped for linkage only, admins are alerted if the booking is still live,
and a payload carrying neither cash field fails the event into the
FAILED-retry sweep rather than settling blind. Both credit-minting arms —
cash landing on an already-cancelled booking's stale invoice, and the
late-capacity-failure cancel — mint member credit sized by the invoice's
quantified cash, clamped to the payment amount (#1357/#1459) and, across all
payments matched to one invoice, to the invoice's remaining cash (#1505): a
mixed cash+allocation invoice credits only the cash portion, the admin alert
names both amounts so the allocation source gets verified, and verified cash
arriving after a mint alerts with the delta (it never credits automatically).
Two never-settled payments on one invoice each mint no more than the invoice's
cash NOT already minted for the other (a defensive invariant — no app flow
produces that shape; the remaining-cash read-back happens inside each payment's
reconcile transaction under the shared advisory lock, so it stays idempotent
under retry, and a capped mint raises the same loud alert, never a silent
overmint).

```mermaid
sequenceDiagram
    autonumber
    participant XERO as Xero
    participant WH as /api/webhooks/xero
    participant DB as Postgres<br/>(XeroInboundEvent / ProcessedWebhookEvent)
    participant W as xero-inbound-reconciliation
    participant REC as Per-entity reconcilers
    participant BIZ as Booking / payment / membership state

    XERO->>WH: POST events (HMAC signature)
    WH->>WH: verify HMAC-SHA256 (timing-safe), bound body/count
    loop each event
        WH->>DB: recordXeroInboundEvent(RECEIVED,<br/>unique correlationKey — duplicate-safe)
    end
    WH-->>XERO: 200 ok
    WH--)W: after(): runXeroInboundReconciliationCycle<br/>(batch ≤10, ≤3 batches; cron ?task=inbound sweeps)

    loop claimed events (RECEIVED, or FAILED past backoff)
        W->>DB: claim → PROCESSING; dedupe via ProcessedWebhookEvent
        W->>DB: startXeroSyncOperation(INBOUND, WEBHOOK_RECONCILE)
        W->>REC: processXeroInboundEvent(event)
        alt CONTACT
            REC->>BIZ: refresh contact cache + member link,<br/>managed group sync, membership backfill
        else INVOICE (paid)
            REC->>BIZ: syncInternetBankingPaymentsForPaidInvoice:<br/>cash-gated (#1435) — with cash evidence flip IB<br/>payments → PAID, confirm booking, bed allocation,<br/>waitlist, emails; allocation-only PAID settles nothing<br/>(identifier stamp + live-booking admin alert)
            REC->>BIZ: syncGroupSettlementForPaidInvoice:<br/>same cash gate; with cash evidence flip all<br/>joiner bookings on the organiser invoice
            REC->>BIZ: refresh linked subscriptions
        else PAYMENT / CREDIT-NOTE
            REC->>BIZ: reconcile payment / credit note:<br/>refund business-state repair,<br/>account-credit allocation repair
        end
        W->>DB: complete op + mark event PROCESSED<br/>(on error: FAILED + backoff, release dedupe claim)
    end

    Note over W: then cursor-driven incremental reconciliation<br/>(XeroSyncCursor + minimum intervals):
    W->>REC: contacts changed since cursor (syncContactsFromXero)
    W->>REC: membership invoices since cursor
    W->>REC: invoice reconciliation driver
```

Operator replay (`/api/admin/xero/inbound-events/[id]/replay`) deletes the
dedupe row, resets the event to RECEIVED, and reprocesses it synchronously —
allowed for FAILED/PROCESSED events and for PROCESSING events older than the
staleness threshold (dead-worker takeover).

## Flow 3 — Repair and hardening

Reconciliation heals what Xero tells us about; repair audits what we *should*
have told Xero. `runBookingXeroRepair` cross-checks bookings, payments,
modifications, the operation ledger, and object links, then plans and
(optionally) applies corrective actions — almost all of which are just new
outbox operations, so Flow 1 idempotency applies.

```mermaid
sequenceDiagram
    autonumber
    participant OP as Operator
    participant CLI as scripts/xero-booking-repair.ts<br/>(--dry-run / --apply / --booking / --from --to)
    participant REP as xero-booking-repair
    participant DB as Postgres
    participant OB as Outbox + retry workers

    OP->>CLI: run scoped repair
    CLI->>REP: runBookingXeroRepair(scope, {apply})
    REP->>DB: loadAuditData: bookings + payments +<br/>modifications + XeroSyncOperations + XeroObjectLinks
    REP->>REP: classify findings (13 codes:<br/>MISSING_PRIMARY_INVOICE, STALE_PRIMARY_INVOICE_DETAILS,<br/>CANCELLED_BOOKING_OPEN_INVOICE, XERO_AMOUNT_MISMATCH,<br/>BLOCKED_BY_XERO_OPERATION, ...)
    REP->>REP: plan actions (15 types; safe-to-auto-apply flag:<br/>QUEUE_* invoice/credit-note ops, REQUEUE_XERO_OPERATION,<br/>SYNC_*_LINK/FIELD, MARK_MANUAL_REVIEW)
    opt --apply
        loop up to 3 passes
            REP->>DB: apply safe actions (enqueue outbox ops,<br/>requeue failed ops, fix links/fields)
            REP->>OB: processQueuedXeroOutboxOperations +<br/>processQueuedXeroOperationRetries
            OB->>DB: execute, update ledger
            REP->>DB: re-audit; stop when clean
        end
    end
    REP-->>CLI: pass reports + human summary
```

Scheduled hardening (cron tasks, all idempotent):

- `backfill` — `backfillHistoricalXeroObjectLinks`: creates canonical
  `XeroObjectLink` rows for pre-ledger history (runs `link-cleanup` too).
- `link-cleanup` — `cleanupStaleCanonicalXeroObjectLinks`: deactivates
  superseded canonical links.
- `report` — `sendXeroReconciliationReport`: emailed issue digest (repeated
  failures, unsupported partials, stale pending, persistently-failing inbound
  events, link problems).
- Repeated-failure alerting (`maybeNotifyXeroRepeatedFailure`) and the
  once-per-hour error alert (`notifyXeroSyncError`) keep failure noise bounded.

Admin triage complements this: the failures overview groups FAILED operations
into actionable states (retryable, requeued, manually resolved,
non-replayable), the health snapshot lists paid bookings missing invoices and
refunds missing credit notes (flagged when the refunded amount still exceeds the
cents already covered by active refund credit notes, so multi-note refunds are
handled), and per-record activity shows the ledger for one booking/payment/member.

Owner-substitution alert (operator runbook): when a booking request's held owner
is no longer a valid non-login contact at conversion, the accept substitutes a
fresh contact rather than failing the requester, and the invoice bills that fresh
contact instead of the intended organisation. This raises the
`admin-owner-substitution` admin email alert (gated by the "Xero sync errors"
preference) alongside a durable `booking_request.owner_substituted` audit row.
On this alert the finance admin reconciles the invoice's Xero contact: repoint the
booking's invoice from the newly-created contact to the intended organisation in
Xero (and archive/merge the stray contact if appropriate). The alert names the
booking request, the booking, the intended vs. substituted contact, and the
substitution reason to guide the fix.

Expanding an operation in the admin Xero operations panel shows a plain-English
summary by default instead of raw JSON (#1448). `summarizeXeroOperation`
(`src/lib/xero-operation-summaries.ts`, a framework-agnostic pure module the
client panel imports) keys on `(entityType, operationType)` plus payload-shape
sniffing: it reads `requestPayload.queueType` when it is still present
(PENDING / failed-before-dispatch rows) and otherwise recognises the persisted
Xero request/response shapes (invoice, credit note, allocation, managed
contact-group sync). It builds facts from data already run through the
object-level `redactSensitiveJson`, so a summary can never surface a value the
redacted raw view would mask, and money is formatted only through the shared
`formatCents` helper (integer cents; Xero decimal dollars are converted to cents
first). Unknown or unmapped shapes return `null`, and the panel falls back to
the redacted raw request/response JSON exactly as before. A per-row **Show raw
JSON** toggle reveals the same redacted `<pre>` blocks for any mapped row.

### Historical rounding-drift audit (#1318, read-only)

Issue #1163 was a 1–2 cent Xero invoice drift: the pre-#1231 line builder grouped
a guest's nights into contiguous **date** runs only and billed each run as
`quantity: nightCount, unitAmount: round(totalCents / nightCount) / 100`. When a
single contiguous run mixed nightly prices (a season boundary, or locked-vs-
re-priced nights), `nightCount * round(totalCents / nightCount)` could not
represent the exact cent total, so the issued invoice's guest-line total drifted.
The legacy no-per-night path drifted the same way whenever `guest.priceCents` was
not divisible by the night count. **PR #1231 fixed it for new invoices** by
splitting every run to a single price (so `perNightCents * nightCount ===
totalCents` by construction) but did **not** retroactively heal already-issued
invoices.

**Stance on historical data:**

- **Fresh install / new deployment — no action.** There is no pre-#1231 history to
  heal, so nothing to run.
- **Fork or existing install — self-check with the audit.** `xero-invoice-rounding-audit`
  (`scripts/audit-xero-invoice-rounding.ts`) replays the pre-#1231 maths in
  integer cents over persisted booking/guest/night data and flags issued
  invoices whose guest-line total would have drifted. It scans **both** invoice
  sources that use `buildInvoiceLineItems`:
  - **Per-booking invoices** (`Payment.xeroInvoiceId`), keyed off the booking's
    guests/nights, and
  - **Group-booking settlement invoices** (`GroupBookingSettlement.xeroInvoiceId`).
    For each settlement it re-runs the **exact** child query the real builder uses
    (`xero-group-settlement-invoices.ts`: `parentBookingId = organiserBookingId`,
    `organiserSettled = true`, `deletedAt = null`, `status in {CONFIRMED, PAID}`)
    and sums each settleable child's per-guest run drift, so the reconstructed
    line-item input matches what was invoiced.

  It is a **diagnostic only**: zero live-provider calls, no transactions, no
  mutations — it issues only `booking.findMany` +
  `groupBookingSettlement.findMany` reads (cursor-paginated). Run it against a
  **non-production copy** of the database:

  ```bash
  DATABASE_URL='postgresql://user:pass@host:5432/scratch_copy' \
    npx tsx scripts/audit-xero-invoice-rounding.ts --issued-before 2026-07-04
  # or: npm run xero:audit-invoice-rounding -- --issued-before 2026-07-04
  ```

  `--issued-before <YYYY-MM-DD>` should be the date you deployed #1231; it scopes
  the scan to invoices created before the fix via the issued-at proxy —
  `Payment.createdAt` for booking invoices and `GroupBookingSettlement.createdAt`
  for settlement invoices (both pre-exist their Xero invoice, so the filter is
  over-inclusive-but-safe). Omit it to scan every issued invoice. The report
  labels each candidate `[BOOKING]` or `[GROUP SETTLEMENT]` and prints the invoice
  id/number, the affected line run, and the computed drift in cents.

- **A flag is a candidate, not a proven error.** It means the local data would have
  produced a drifting line total under the pre-#1231 builder. It does **not** prove
  the live Xero invoice is still wrong: the invoice may have been issued after
  #1231 (already correct — the `createdAt` proxy is over-inclusive), or since been
  voided / credited / superseded. The audit also replays against the **current**
  persisted night data: a booking (or, for a settlement, **any one of its child
  bookings**) re-priced, modified, or cancelled after the invoice was issued will
  replay against post-change data that may differ from what was actually invoiced.
  The audit cannot see Xero invoice status, so **confirm each candidate against
  Xero before acting.**
- **Remediation is out of scope here.** Any correction is a **manual accounting
  action** (a Xero credit note / adjustment by the operator) or a separately-scoped
  repair task — this audit never edits money, invoices, or Xero.

Scope boundary: only `buildInvoiceLineItems` carries this pattern, and both its
callers — per-booking invoices and `xero-group-settlement-invoices` — are now
scanned. The entrance-fee and supplementary builders emit single `quantity: 1`
exact-cent lines and cannot drift, so they are out of scope by construction.

## OAuth and token lifecycle (supporting flow)

1. Admin hits `/api/admin/xero/connect` → consent URL with a signed state
   cookie (`xero-oauth-state`).
2. Xero redirects to `/api/admin/xero/callback` → `handleXeroCallback`
   validates state, exchanges the code, and `saveXeroTokens` encrypts
   access/refresh tokens with `XERO_ENCRYPTION_KEY` into the single `XeroToken`
   row (tenant id included).
3. Every worker call goes through `getAuthenticatedXeroClient`: if the access
   token is near expiry it claims the refresh lease
   (`refreshInProgressUntil`); the winner refreshes and persists, losers wait
   out the lease and re-read. This keeps serverless concurrency from burning
   refresh tokens.
4. `/api/admin/xero/disconnect` revokes and deletes tokens; workers then
   short-circuit via `isXeroConnected()` (cron records SKIPPED).

## Refactor opportunities (ranked)

Ranked by risk-reduction value; item 1 touches the most money-path logic.
These are candidates for future issues, not commitments.

1. **Split `xero-inbound-reconciliation.ts` (3,427 lines).** _Done (#1208 item 1
   / #1270):_ the file was split verbatim (behavior preserving, export-parity)
   into cohesive `src/lib/xero-inbound/<concern>.ts` sub-modules with an acyclic
   import graph — `types` (all interfaces + `XeroInboundReplayError`) and
   `constants` are leaves; the shared helpers `amounts` (money/credit/allocation
   math + metadata guards, including the still-local `getJsonRecord`),
   `object-links` (link dedupe/derive/find/recover) and `audit` sit above them;
   the per-concern reconcilers `contact`, `payment`, `invoice-paid-effects`
   (the internet-banking settlement flip + group-settlement side effects),
   `invoice`, `credit-note-repairs` (the two big business-state repairs
   `repairRefundedPaymentBusinessState` ~260 lines and
   `repairAccountCreditAllocationBusinessState` ~220 lines), `credit-note`, and
   the `incremental-reconciliation` cursor drivers depend only downward
   (`invoice` → `payment`/`contact`/`invoice-paid-effects`; `credit-note` →
   `credit-note-repairs`); and the `event-processing` worker (claim, dedupe,
   backoff, replay + the stored-event dispatcher and the public cycle/replay
   entry points) sits on top. `xero-inbound-reconciliation.ts` remains the entry
   as a re-export barrel over the unchanged public surface (3 functions +
   5 result types + `XeroInboundReplayError`) so every importer and the
   `xero-inbound-reconciliation.test.ts` doubles resolve unchanged. The
   settlement/repair code — the highest-risk money logic in the subsystem — now
   lives in `invoice-paid-effects` and `credit-note-repairs` where it can be
   reviewed in isolation.
2. **Split `xero-booking-repair.ts` (3,004 lines).** _Done (#1208 item 2):_
   the ~2,700 lines of private helpers were extracted verbatim (behavior
   preserving) into cohesive `xero-booking-repair-<phase>.ts` sub-modules —
   `-types`, `-deps`, `-utils`, `-payments`, `-object-resolution`, `-analysis`,
   `-findings`, `-classify`, `-load`, `-passes` — with an acyclic import graph
   (types/deps/utils are leaves; `classify` depends downward; the entry sits on
   top). `xero-booking-repair.ts` remains the entry (the `runBookingXeroRepair`
   orchestrator plus `formatBookingXeroRepairHumanSummary`) and re-exports the
   unchanged public surface. `classifyBookingContext` is a single sequential
   function that mutates its own local accumulators, so it stays whole in
   `-classify` (kept together, above the LOC soft cap, rather than editing the
   body). The private helpers still duplicate utilities elsewhere (JSON readers
   vs. `asRecord` copies in 4+ xero modules; `dollarsToCents` vs. shared money
   utils); de-duplicating them is deferred to item 6 to keep this split
   behavior-preserving.
3. **Make the outbox queue type first-class.** The PENDING query is a
   hand-written 12-branch `OR` over the `requestPayload.queueType` JSON path
   (unindexable), the dispatcher is a 12-way switch, and the 12 `enqueue*`
   functions repeat the same insert shape. A registry map
   (`queueType → {expectedOperation, handler}`) plus deriving the filter from
   the payload module's constant list removes three copies of the same
   knowledge. **Done (#1271):** `queueType` is now a denormalized, indexed
   `XeroSyncOperation` column (`@@index([queueType, status, createdAt])`),
   captured once at enqueue in `startXeroSyncOperation` (and backfilled from
   `requestPayload->>'queueType'`) and never updated afterward. The payload field
   stays canonical — the PENDING-scan `OR` and the parsing switch still read it.
   **Why the column mirrors the payload only pre-dispatch:** the column mirrors
   the payload only for rows still awaiting dispatch (`PENDING`/`WAITING_PAYMENT`);
   once a row is dispatched some handlers (e.g. the booking-invoice create/update)
   overwrite `requestPayload` wholesale and drop `queueType`, so the column and
   payload diverge post-dispatch. That is safe because the only consumer is the
   PENDING outbox scan (switched to the column in #1272 part 1), whose set is
   exactly the pre-dispatch set where column and payload still agree; the
   dispatcher and the parsing switch still read `queueType` from the payload.
   Making the column the sole discriminator everywhere is the remaining #1272
   consolidation (see item 4).
4. **Unify the operation-replay stack.** `xero-operation-outbox`,
   `xero-operation-outbox-payload`, `xero-operation-queue`, and
   `xero-operation-retry` describe one lifecycle (enqueue → scan/dispatch →
   execute → retry/replay → payload). _Done (#1272), in two owner-reviewed
   parts:_
   - _Part 1:_ the PENDING outbox scan
     (`processQueuedXeroOutboxOperations`) now filters on the indexed
     `queueType` column (using the `(queueType, status, createdAt)` index)
     instead of a hand-written 12-branch `requestPayload->>'queueType'` OR
     predicate, and the 12 queue-type values are consolidated into one exported
     `XERO_OUTBOX_QUEUE_TYPES` list in `xero-operation-outbox-payload` that the
     scan's `IN` consumes (single source of truth; per-type dispatch routing and
     the payload parse switch are byte-identical).
   - _Part 2:_ the duplicated claim-to-RUNNING `updateMany` in the outbox scan
     and the retry scan is extracted verbatim into one shared
     `claimXeroSyncOperationToRunning(id, guard)` primitive
     (`xero-operation-claim`); both callers delegate, passing only their
     guard predicate, so each resulting `WHERE` (and the atomic `count === 1`
     single-flight) is identical to before. A dispatch-domain test now drives the
     real if/else chain to prove it routes exactly `XERO_OUTBOX_QUEUE_TYPES`.

   _Deliberately not pursued (owner decision):_ physically co-locating the four
   files behind one `xero-operation-replay` boundary and folding
   `xero-stale-operations` plus complete/fail/requeue/stale into a single
   lifecycle god-helper — the column scan (part 1) and the shared claim helper
   (part 2) are the consolidations that de-duplicate real logic and close #1272;
   the rest would be churn without a behavioral payoff.
5. **Split `xero-hardening.ts` (1,606 lines).** _Done (#1208 item 5):_ the
   private helpers were extracted verbatim (behavior preserving) into cohesive
   `xero-hardening-<concern>.ts` sub-modules with an acyclic import graph —
   `-types` (all public type contracts plus the two shared private
   record types) and `-shared` (the failure-window/scope-key helpers and the
   REQUEUE/threshold constants used by more than one concern) are leaves;
   `-canonical-links` (`cleanupStaleCanonicalXeroObjectLinks`),
   `-repeated-failure` (`maybeNotifyXeroRepeatedFailure`), `-report`
   (`buildXeroReconciliationReport` + `sendXeroReconciliationReport`, including
   the #1196 persistently-failing inbound-events section), and `-backfill`
   (`backfillHistoricalXeroObjectLinks`) each depend only on the two leaves.
   `xero-hardening.ts` remains the entry and re-exports the unchanged public
   surface (5 functions + 9 types) so `xero-cron-runner`, the admin
   link-maintenance route, `xero-sync`, and the tests resolve unchanged.
   `-report` stays above the LOC soft cap (~960 lines) because it is
   irreducible under this split's own rules: `buildXeroReconciliationReport` is
   a single ~610-line function that must stay whole (carving it would break
   behavior preservation), and its remaining report-only helpers
   (`groupRepeatedFailures`, the issue-item/URL builders, the age/cutoff
   helpers) and report-only `Pick` types are consumed nowhere else, so moving
   them out would force exporting private helpers rather than keeping them
   module-internal.
6. **De-duplicate micro-helpers.** _Partly done (#1208):_ the byte-identical
   `asRecord`/`readString`/`readNumber` guards that appeared in `xero-sync`,
   `xero-operation-queue`, `xero-operation-retry`, `xero-admin-failures`, and
   `xero-operation-outbox-payload` now import from the shared `xero-json`
   module. The differently-shaped `getJsonRecord` guards from
   `xero-inbound-reconciliation` now live (still local, NOT merged into
   `xero-json`) in its `xero-inbound/amounts` sub-module after the item-1 split
   (#1270); merging them into `xero-json` is intentionally deferred to preserve
   behavior. The
   `readJsonRecord`/`readJsonString`/`readJsonNumber` guards from
   `xero-booking-repair` now live (still local, NOT merged into `xero-json`) in
   its `xero-booking-repair-utils` sub-module after the item-2 split; merging
   them into `xero-json` is intentionally deferred to preserve behavior.
7. **Finish retiring the `xero.ts` facade inside the subsystem.** _Done
   (#1208):_ no `src/lib/xero-*` module imports the `@/lib/xero` facade anymore
   — each imports the source domain module directly, and an `eslint.config.mjs`
   `no-restricted-imports` override forbids the facade path from `xero-*` files
   to hold the boundary. The facade stays for external callers.
8. **Minor:** _Partly done (#1208):_ the `messageForTask` nested-ternary chain
   in `xero-cron-runner` is now a `switch`. The webhook route's per-category
   `if` blocks were kept — they emit real observability log lines, so dropping
   them would change log output rather than being no-ops.
