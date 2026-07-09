-- Metadata-only data repair: redact plaintext door codes from historical
-- AuditLog metadata (issue #1665).
--
-- Door codes are physical-access secrets. The lodge admin routes redact them
-- going forward as of PR #1663 (redactLodgeForAudit: string value -> '[set]',
-- absent code -> null), but between the multi-lodge release that introduced
-- the lodge audit blocks (raw serializeLodge, which includes doorCode) and
-- PR #1663, every lodge create/update wrote the code in plaintext under
-- FOUR actions — the [id] route picks LODGE_UPDATED / LODGE_ACTIVATED /
-- LODGE_DEACTIVATED for the same previousLodge/newLodge metadata shape:
--
--   LODGE_CREATED                                  metadata.newLodge.doorCode
--   LODGE_UPDATED / LODGE_ACTIVATED /              metadata.previousLodge.doorCode,
--   LODGE_DEACTIVATED                              metadata.newLodge.doorCode
--
-- EMAIL_MESSAGE_SETTINGS_UPDATED previousSettings/newSettings.doorCode is
-- also covered, purely defensively: its redactor shipped in the same commit
-- as the doorCode field itself (the door-code-reminders release), so no
-- plaintext rows are expected there — the statements are shape-guarded
-- no-ops unless some unexpected row exists. The columns themselves were
-- dropped by 20260709130000; this touches only audit history.
--
-- Rewrite each to the forward convention '[set]'. Idempotent and
-- shape-guarded: only JSON string values other than '[set]' are touched, so
-- JSON nulls keep recording "no code was set", already-redacted rows are
-- skipped, and re-running is a no-op. Scoped by action (indexed) so the
-- UPDATEs never scan unrelated audit rows. No DDL; AuditLog is not a
-- blue/green hot table; old colours only ever read redacted metadata sooner.

UPDATE "AuditLog"
SET "metadata" = jsonb_set("metadata", '{newLodge,doorCode}', '"[set]"'::jsonb)
WHERE "action" IN ('LODGE_CREATED', 'LODGE_UPDATED', 'LODGE_ACTIVATED', 'LODGE_DEACTIVATED')
  AND jsonb_typeof("metadata" #> '{newLodge,doorCode}') = 'string'
  AND "metadata" #>> '{newLodge,doorCode}' <> '[set]';

UPDATE "AuditLog"
SET "metadata" = jsonb_set("metadata", '{previousLodge,doorCode}', '"[set]"'::jsonb)
WHERE "action" IN ('LODGE_UPDATED', 'LODGE_ACTIVATED', 'LODGE_DEACTIVATED')
  AND jsonb_typeof("metadata" #> '{previousLodge,doorCode}') = 'string'
  AND "metadata" #>> '{previousLodge,doorCode}' <> '[set]';

UPDATE "AuditLog"
SET "metadata" = jsonb_set("metadata", '{previousSettings,doorCode}', '"[set]"'::jsonb)
WHERE "action" = 'EMAIL_MESSAGE_SETTINGS_UPDATED'
  AND jsonb_typeof("metadata" #> '{previousSettings,doorCode}') = 'string'
  AND "metadata" #>> '{previousSettings,doorCode}' <> '[set]';

UPDATE "AuditLog"
SET "metadata" = jsonb_set("metadata", '{newSettings,doorCode}', '"[set]"'::jsonb)
WHERE "action" = 'EMAIL_MESSAGE_SETTINGS_UPDATED'
  AND jsonb_typeof("metadata" #> '{newSettings,doorCode}') = 'string'
  AND "metadata" #>> '{newSettings,doorCode}' <> '[set]';
