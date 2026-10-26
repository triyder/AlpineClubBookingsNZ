- **Finance diagnostics now say what each queued card refund or cancel is (#4076).**
  A refund queued to the group organiser's card (for a joiner's booking edit, a
  group cancellation or an approved refund appeal), a retry of an older whole-group
  refund, an officer-confirmed edit refund or charge, a booking edit's own refund,
  the refund of a payment made on an already-replaced payment request, and an
  approved late-capture refund were each reported as another scenario or as an
  unrecognised recovery. Each now carries its own scenario code and a plain-English
  label, and the labels moved into the tool descriptions so they no longer take
  room from the rows. A test fails when an export of `payment-recovery-keys.ts` is
  neither mapped to a scenario nor declared not a recovery key. Read-only
  diagnostics; the recovery key builders moved into `payment-recovery-keys.ts`
  with their output unchanged, and nothing about payments behaves differently.
