# File-size allowances for #4357 - every saved-card door charges worth

Both routes already exceed the route-handler budget. Each gains only the
import of the one shared figure and the lines that read it under the locks,
with short notes citing `INV-PAY-119`. The figure itself moved OUT
of `cron-confirm-pending.ts` into `booking-payment-state.ts`, so no route gains
the rule.

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 947
reason: the officer's saved-card claim sizes its Payment upsert, attempt row
  and charge from `savedCardChargeCents(locked)`, read once beside the locked
  card where the claim is built; and its "$0" branch decides on the same
  figure, re-checking it under the locks it already takes (review F3), so a
  change fee on a $0 booking is charged rather than confirmed free. Splitting
  either lock-ordered transaction out of the route is a refactor this fix does
  not otherwise touch.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 664
reason: the same one figure, read once under the claim's locks beside the
  attempt it sizes, plus its import; the claim transaction is the route's body.
