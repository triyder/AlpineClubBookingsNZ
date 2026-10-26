# File-size allowance for #4399 - the $0 saved-card doors

`charge-saved-method/route.ts` is already over the route-handler budget and
grew in #4394 (`size-allowances.d/4394-saved-card-charge-worth.md`). It gains
only the guard this issue needs, at the one place it can sit: inside the
transaction that holds the locks it relies on. (The officer's
confirm-pending-guests route shrank here: its $0 payment write moved into the
shared `zero-worth-confirm-payment.ts`.)

file: src/app/api/payments/charge-saved-method/route.ts
lines: 668
reason: the worth-is-zero refusal (+4) must read the under-lock re-read beside
  the card check, inside the claim transaction that is the route's body.
