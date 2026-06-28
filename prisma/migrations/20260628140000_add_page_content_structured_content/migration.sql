-- Add structured, plain-text editable content slots for code-backed website
-- pages. Existing rich-text CMS pages remain valid because every row receives
-- the empty-object default.
ALTER TABLE "PageContent" ADD COLUMN "structuredContent" JSONB NOT NULL DEFAULT '{}';
