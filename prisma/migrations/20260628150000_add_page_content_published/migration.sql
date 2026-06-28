-- Add a publish/visibility flag for CMS pages so admins can hide an
-- admin-created page from the public site without permanently deleting it.
-- Existing rows default to published, so current behaviour is unchanged.
ALTER TABLE "PageContent" ADD COLUMN "published" BOOLEAN NOT NULL DEFAULT true;
