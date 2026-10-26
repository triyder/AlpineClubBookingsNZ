The new amountDue token joins the one token vocabulary beside amount (#4058, `INV-PAY-119`).

file: src/lib/email-message-registry.ts
lines: 2235
reason: The new amountDue token joins the one token vocabulary beside amount; it belongs beside the code it describes, and splitting this module is its own refactor unrelated to the bug.
