The split-guest pay-link email reads the amount owed through the one reader
(`INV-PAY-119`, #4058): one import line.

file: src/lib/cron-confirm-pending.ts
lines: 2057
reason: One import line for the shared amount-owed reader; the cron's split-guest send must quote what the pay page asks, and splitting this 2,000-line module is its own refactor unrelated to the bug.
