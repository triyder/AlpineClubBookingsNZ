# File-size allowance for #4078

Audience: Developer, Agent.

file: src/lib/stripe-webhook-service.ts
lines: 1843
reason: the existing webhook dispatcher and audit writer must import the one
  additional-ask intent tag defined by ordinary-ask-request.ts (INV-SSOT-001).
  This adds only the import line; both uses replace existing literal values.
  Extracting the webhook branches to avoid that line would turn a byte-identical
  tag refactor into a separate lifecycle refactor without reducing this rule.
