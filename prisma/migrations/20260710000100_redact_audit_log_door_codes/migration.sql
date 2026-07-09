-- Metadata-only data repair: redact plaintext door codes from historical
-- AuditLog metadata (issue #1665).
--
-- Door codes are physical-access secrets. The lodge admin routes redact them
-- going forward as of PR #1663 (redactLodgeForAudit: string value -> '[set]',
-- absent code -> null), and the email-settings route redacted them from the
-- door-code-reminders release until the columns were dropped — but rows
-- written before those points still hold the code in plaintext:
--
--   LODGE_CREATED                   metadata.newLodge.doorCode
--   LODGE_UPDATED                   metadata.previousLodge.doorCode,
--                                   metadata.newLodge.doorCode
--   EMAIL_MESSAGE_SETTINGS_UPDATED  metadata.previousSettings.doorCode,
--                                   metadata.newSettings.doorCode
--
-- Rewrite each to the forward convention '[set]'. Idempotent and
-- shape-guarded: only JSON string values other than '[set]' are touched, so
-- JSON nulls keep recording "no code was set", already-redacted rows are
-- skipped, and re-running is a no-op. Scoped by action (indexed) so the
-- UPDATEs never scan unrelated audit rows. No DDL; AuditLog is not a
-- blue/green hot table; old colours only ever read redacted metadata sooner.

UPDATE "AuditLog"
SET "metadata" = jsonb_set("metadata", '{newLodge,doorCode}', '"[set]"'::jsonb)
WHERE "action" IN ('LODGE_CREATED', 'LODGE_UPDATED')
  AND jsonb_typeof("metadata" #> '{newLodge,doorCode}') = 'string'
  AND "metadata" #>> '{newLodge,doorCode}' <> '[set]';

UPDATE "AuditLog"
SET "metadata" = jsonb_set("metadata", '{previousLodge,doorCode}', '"[set]"'::jsonb)
WHERE "action" = 'LODGE_UPDATED'
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
