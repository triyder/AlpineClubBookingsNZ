# File-size allowances for #4042

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2220
reason: the finance queue card gains the group organiser hand-back's own
  explaining paragraph and the flag that keeps the cash paragraph from
  speaking for it; every other kind's paragraph and flag live in this same
  render, so the new one has to sit beside them rather than in a module of
  its own; so do the group row's paid-back dialog wording and the Dismiss
  control it does not offer, and the completion's request carrying the total
  the card showed.

file: src/lib/email-message-registry.ts
lines: 2278
reason: the "Manual refund needed" message gains its two note tokens, which
  the registry declares in its three existing tables (required body tokens,
  editor previews, the token allowlist) beside every other composed note; the
  trigger summary and frequency now name the group case; the third token
  (whom the money goes back to) and the required subject token sit in the
  same tables.

file: src/lib/group-cancel.ts
lines: 962
reason: eleven lines book each joiner's share on the organiser's hand-back inside
  the per-child claim that records it (the writer itself is
  `group-organiser-hand-back.ts`), carry it out of the claim, name it in the
  child's audit, and run the alert sweep once the loop ends, from a finally
  around it so an escaping error still runs it; each has to sit in the claim
  or around the loop it belongs to.

file: src/lib/email-message-renderer.ts
lines: 958
reason: the "Manual refund needed" message's two required tokens get the
  plain-English missing-token guidance every other required token has, in the
  two guidance tables that live here beside the check that reads them.

file: src/lib/cron-group-settlement-reaper.ts
lines: 1067
reason: the reaper gains its task-keyed retry of a group organiser hand-back
  alert left unsent after a group's last claim (the sweep itself is
  `group-organiser-hand-back.ts`): one import, the result's counter and its
  zero, and an entry point that runs the reap and the resume and then the
  sweep, which runs even when a step before it throws; it reuses the resume's
  grace, so it has to sit beside it.
