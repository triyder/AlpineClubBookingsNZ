# Function-length allowances for fork #127/#130 (work party: started stays, and Remove)

The feature's logic is in `src/lib/work-party-booking-correction.ts`, under
its budget. The correction's code day sits in
`booking-batch-work-party-correction.ts`, and its admission and removal sit in
`promo-code-list-rules.ts`, so the batch service and `booking-modify-plan.ts`
do not grow past upstream's hard ceiling (#4926). Three already-long functions
grow because the change must happen inside the one canonical booking-edit
pipeline and the one booking page, not beside them (`INV-SSOT`; the issues
reject a second path).

function: src/lib/booking-batch-modification-service.ts#modifyBookingBatch
lines: 1838
reason: the edit policy is asked for the officer-only "work-party-correction"
  mode beside the finished-stay correction's identical flag, and the pricing
  pass is told the correction moves no bed. Each is one line on the call it
  changes.

function: src/components/admin/admin-booking-tools-card.tsx#AdminBookingToolsCard
lines: 329
reason: the card passes the booking's current work party, so Remove replaces
  Add on a booking already on one (#130). The controls are their own component.

function: src/app/(authenticated)/bookings/[id]/_lib/booking-detail-editor-data.ts#buildBookingDetailEditorData
lines: 311
reason: the booking page reads which work party the booking is on, beside the
  data it already loads for the officer tools card.
