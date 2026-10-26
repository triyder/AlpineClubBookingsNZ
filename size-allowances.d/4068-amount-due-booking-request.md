The approved-request pay-link send gains the amountDueCents argument and the reason it is the price (#4058, `INV-PAY-119`).

file: src/lib/booking-request.ts
lines: 3073
reason: The approved-request pay-link send gains the amountDueCents argument and the reason it is the price; it belongs beside the code it describes, and splitting this module is its own refactor unrelated to the bug.
