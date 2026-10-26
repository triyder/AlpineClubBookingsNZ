# File-size allowances for #4110 (re-bill a closed or voided family) and the #4098 review fixes

file: src/app/api/admin/subscription-billing/route.ts
lines: 362
reason: the panel's read of the charge queue now carries each covered
  member's released marker and subscription status, so Close is offered only
  where the close can succeed. It is the same include on the same query, with
  the two lines saying why; a second query or route for it would split one
  payload the panel reads in one place.

file: src/lib/membership-subscription-billing.ts
lines: 1897
reason: the preview decides which family charges still bill their family
  (owner decisions on #4110: a closed charge does until a covered member's
  payment is reversed; the newest closed charge decides; a member exempt at
  the close or reversed under an older charge is an exception asking Finance
  to decide; every closed charge informs the warning and that exception;
  only a difference invoice passes the family hold; a re-bill beside a
  member's invoice warns; a reversal the hold keeps back is a decision), and
  the confirm acknowledges
  or withholds the partial-reversal warning. Each rule reads the family-charge query's own rows and feeds the
  same billedFamilyTypes map and exceptions list the preview loop uses. The
  predicates, wording and the billing-family resolution already live in
  subscription-charge-already-paid.ts and membership-billing-family.ts; what
  remains is the preview's and confirm's own use of them, and moving that out
  would split one preview decision and one confirm transaction across files.

file: src/lib/xero-operation-retry.ts
lines: 2025
reason: Xero Operations must explain a stray subscription invoice (raised
  after its charge was closed as paid) with its own reason rather than the
  generic payload-repair text. That is one early branch in the PARTIAL
  dispatch every retry reason comes from, reading the shared predicate and
  message, plus their import.
