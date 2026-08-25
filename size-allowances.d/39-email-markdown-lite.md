# File-size allowances for #39 (fork PR — markdown-lite email bodies, fork issue #38)

The toolbar itself was split into its own component
(`markdown-lite-toolbar.tsx`, well under budget) rather than granted an
allowance; what remains below is the irreducible wiring in three files that
are each the canonical single home for their half of the feature.

file: src/components/admin/email-settings/email-message-settings-panel.tsx
lines: 999
reason: +20 — the textarea ref, the toolbar mount point, and the
`bodyMarkdown: true` field on the save and preview payloads. The panel is the
single staged-edit surface for email templates; the toolbar's bulk already
lives in its own component.

file: src/lib/email-message-renderer.ts
lines: 866
reason: +18 — the per-override renderer choice (`bodyMarkdown` →
markdown-lite twin vs. the plain path) at the two render sites (send and
preview) plus the record-type field. The renderer is the single authority on
how a stored override becomes HTML; the formatting logic itself lives in the
new src/lib/email-markdown-lite.ts and layout.ts, both under budget.

file: src/app/api/admin/email-templates/route.ts
lines: 590
reason: +12 — the optional `bodyMarkdown` field through the update schema,
the preserve-when-omitted upsert rule, and the serialized override. This
route is the single save/read surface for template overrides.
