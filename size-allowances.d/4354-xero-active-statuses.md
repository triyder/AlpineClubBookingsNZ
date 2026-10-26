# File-size allowances for #4354

file: src/lib/payment-reconciliation.ts
lines: 2931
reason: A single import replaces a duplicated status list with the shared leaf constant; splitting the existing writer is outside this behavior-preserving refactor.

file: src/lib/xero-sync.ts
lines: 1133
reason: A single import replaces a duplicated status list with the shared leaf constant; splitting the existing writer is outside this behavior-preserving refactor.
