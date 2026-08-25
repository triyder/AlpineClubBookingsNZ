-- Fork #38: markdown-lite formatting flag on email body overrides.
-- Additive with a NOT NULL default, so the deployed old code keeps reading
-- and writing this table unchanged (expand-safe per BLUE_GREEN_MIGRATION_POLICY);
-- rows saved before the feature stay false and render exactly as before.
ALTER TABLE "EmailTemplateOverride" ADD COLUMN "bodyMarkdown" BOOLEAN NOT NULL DEFAULT false;
