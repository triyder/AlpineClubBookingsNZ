# Authoritative Fee Configuration

Annual membership fees and entrance fees are persisted, effective-dated club
configuration. Hut fees remain the lodge-scoped `Season` and `SeasonRate`
records managed under **Admin > Hut Fees & Seasons**.

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
missing schedule. `REMAINING_MONTHS_INCLUSIVE` records later billing policy;
this workflow does not create or send invoices.

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
