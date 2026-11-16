# File-size allowances for fork #127/#130 (work party: started stays, and Remove)

The feature's logic stays in `src/lib/work-party-booking-correction.ts`, under
its budget. Two already-over-budget files grow because the change must happen
inside the one canonical booking-edit pipeline, not beside it (`INV-SSOT`; the
issues reject a second path).

file: src/lib/booking-batch-modification-service.ts
lines: 2865
reason: the work-party argument gains its direction (add or remove), and the
  service hands the edit policy the officer-only "work-party-correction" mode
  and the promo engine the one code a Remove drops. Each is one line beside the
  existing admission it mirrors; moving them out would split the argument's
  handling across two files.

file: src/lib/booking-modify-plan.ts
lines: 3035
reason: `applyPromoCodeChanges` takes the code a Remove drops, beside the
  Add's admission it mirrors, and drops it from the requested list next to the
  several-codes carry rule it overrides. The rule and its one exception have
  to be read together.
