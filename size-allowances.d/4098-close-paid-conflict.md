# File-size allowances for #4098 (close a subscription charge already paid)

file: src/app/api/admin/subscription-billing/route.ts
lines: 360
reason: the subscription billing route is the one finance-edit dispatcher for
  every officer action on the Subscriptions page, and its discriminated-union
  schema is the contract the panel posts against. The new action is one more
  arm of that union, a thin call into the close service (which holds all the
  logic, in its own module) and the mapping of that service's refusals to HTTP
  statuses. A second route for one action would split the page's actions and
  their shared edit guard and revalidation across two handlers.

file: src/lib/xero-operation-outbox.ts
lines: 3326
reason: the outbox failure handler is where a failed subscription invoice
  attempt is written back onto its charge, and it must not reopen a charge an
  officer closed as already paid. The change swaps its VOIDED-only check for
  the shared no-invoice predicate and guards the write's WHERE; the growth is
  that import and the two lines saying why, at the site that needs them.

file: src/lib/xero-operation-retry.ts
lines: 2016
reason: one import line. Xero Operations Retry's refusal of a charge that
  needs no invoice now reads the shared no-invoice predicate instead of its own
  copy of the status list, so the set the retry refuses and the set the outbox
  skips cannot drift apart.
