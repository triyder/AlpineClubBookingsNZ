# File-size allowances for #4171 (#4149, #4170, #4173: a late capture's lost record, and one refunded outside the app)

The alert for a late card payment refunded outside the app is its own template
(`email-templates/admin-late-capture-outside-app.ts`), its own sender
(`email/admin-alerts-late-capture.ts`) and its own leaf note module
(`late-capture-outside-app-note.ts`); what grows here is only its registration.

file: src/lib/email-message-registry.ts
lines: 2323
reason: a new admin email has to be registered where every other one is - its
  name in the admin list, its delivery lock, its required tokens, its trigger
  and frequency definition and its token preview - and the registry tests read
  those five tables from this one module; registering it anywhere else would
  be the second registry the single-source rule forbids.
