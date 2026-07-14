# Authoritative Fee Configuration

Annual membership fees and entrance fees are persisted, effective-dated club
configuration. Hut fees remain the lodge-scoped `Season` and `SeasonRate`
records managed under **Admin > Hut Fees & Seasons**.

Public PageContent blocks are double opt-in: their family is enabled in Admin >
Page Content and membership types are individually public. Entrance blocks omit
categories without a current schedule and never expose the compatibility Xero
fallback. Hut-rate blocks use active seasons/rates plus configured age-tier
labels. Visibility writes are audited and invalidate public routes.

## Operator workflow

1. A Membership editor opens **Admin > Membership Types**, writes a distinct
   public description, and explicitly enables public listing only after review.
   Every migrated and newly created type is hidden by default.
2. A Finance editor opens **Admin > Membership & Entrance Fees** and adds an
   inclusive effective-date range. Ranges for the same type/category cannot
   overlap. NZD amounts are stored as GST-inclusive integer cents.
3. For `PER_FAMILY` fees, choose one active member of every membered family as
   billing member. Login holder and family admin are never inferred. Families
   without one are visible exceptions and omitted from invoice generation.
4. Review the effective date before saving. Writes are audited and invalidate
   public page caches.

`NO_INVOICE` is explicit configuration, requires zero cents, and differs from a
missing schedule. `REMAINING_MONTHS_INCLUSIVE` is consumed by the subscription
billing workflow below.

## Subscription invoice workflow

1. Open **Admin > Subscriptions**, choose the membership year and decision date,
   and refresh the preview. The preview is read-only and makes no provider call.
2. Resolve every listed fee, assignment, family, recipient, and
   `subscriptionIncome` mapping exception. A
   per-family recipient must be active, unarchived, and a member of that exact
   family; login holder and family admin are never inferred.
3. Review each recipient, covered member, billing basis, inclusive month count,
   GST-inclusive integer-cent amount, total, current due-days setting, and the
   explicitly configured Xero account/item mapping that confirmation freezes.
4. Explicitly confirm the unchanged preview. Confirmation snapshots those
   values and creates durable outbox work. A later fee, family, or recipient
   change affects future previews only and never rewrites existing charges.
   A member added to an already-billed family is left uncovered with a visible
   `FAMILY_ALREADY_BILLED` exception; the old family snapshot is not expanded
   and a second family invoice is not created.
5. Watch the durable charge queue. `EMAIL_FAILED` can be retried safely because
   the Xero invoice identifier is persisted before email. `CONFLICT` means an
   invoice with the immutable reference exists but its contact, account, amount,
   type, or state does not match; inspect Xero and the local snapshot. The app
   never silently rewrites that provider invoice.

Only an exact `AUTHORISED` invoice with the frozen account/item identifiers and
issue-to-due interval is adoptable. Draft, submitted, paid, voided,
deleted, or otherwise mismatched records are conflicts and are not emailed by
this workflow. Recipient name/email are audit snapshots. Delivery intentionally
uses the recipient member's current Xero contact identity and current Xero
contact email at dispatch time; changing them does not rewrite the snapshot.

Annual invoice runs are never implicit: production operators must review and
confirm the preview. Newly approved members are the exception to the annual-batch
trigger only: their configured charge is queued automatically after approval;
incomplete setup records a visible exception without blocking membership.

## Entrance-fee compatibility window

The migration backfills granular Xero mapping amounts, then the old flat
`entranceFeeAmountCents` for missing categories. Old mappings have no history,
so the migration date is the honest effective-from boundary.

For one compatibility release, reads use the current effective `EntranceFee`
first and deprecated mapping amounts only when no schedule applies. Xero item
and account codes remain provider configuration. Existing config-transfer
bundles still import their old amount columns and work through this fallback;
operators should create authoritative schedules after importing. No live Xero
call occurs during migration or configuration.

## Safety checks

- Confirm current versus compatibility values on the admin page.
- Resolve every family billing exception before a future invoice run.
- Archive rather than delete or merge membership types with fee history.
- Production invoice runs are outside this workflow and require separate
  explicit operator confirmation.
