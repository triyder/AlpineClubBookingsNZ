# File-size allowances for fork #119, PR #128 (add an existing booking to a work party)

The feature's own logic lives in a new module written to its own ceiling,
`src/lib/work-party-booking-correction.ts`, and the batch service's argument
in `src/lib/booking-batch-work-party-correction.ts`. Since upstream's hard
ceiling (#4926), the batch service and `booking-modify-plan.ts` end at or under
their upstream length (the identity-only echo moved to
`booking-identity-only-pricing.ts`, as on thatskiff33#5149). Two functions
grow because the change must happen inside the one canonical booking-edit
pipeline, not beside it (`INV-SSOT`; the issue rejects a second repricing path).

function: src/lib/booking-batch-modification-service.ts#modifyBookingBatch
lines: 1837
reason: the `officerWorkPartyCorrection` argument, its guard call, the promo id
  it admits, the no-fee and full-reduction decisions inside the fee and
  settlement expressions they modify, the audit marker, and fork #132's
  `refundedExcessCreditCents` on the result shapes. Moving those decisions out
  would split one calculation across two files.

function: src/components/admin/admin-booking-tools-card.tsx#AdminBookingToolsCard
lines: 324
reason: the "Add to work party" control (its own component) and the props it
  needs, rendered with the card's other booking tools.
