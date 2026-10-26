# File-size allowance for #4375 (PR #4387)

One entry, two lines: the outbox result's `cooldownDeferred` field and the line
that counts it.

file: src/lib/xero-operation-outbox.ts
lines: 3382
reason: two lines on a 3,380-line file. The count has to be taken where the
  refusal is caught, inside the outbox loop's guarded return-to-PENDING branch,
  and declared on the result type that loop builds, both in this module. The
  cron runner turns it into the cron-health warning that keeps a Xero outage
  from reading green once a worked batch records SUCCESS (#4375). Splitting the
  3,380-line outbox is a separate job with its own review, and it would not
  shrink these two lines.
