-- Convert PageContent from enum-backed fixed pages to dynamic pages.
ALTER TABLE "PageContent" ADD COLUMN "slugText" TEXT;

UPDATE "PageContent"
SET "slugText" = LOWER("slug"::TEXT)
WHERE "slugText" IS NULL;

DROP INDEX IF EXISTS "PageContent_slug_key";
ALTER TABLE "PageContent" DROP COLUMN "slug";
ALTER TABLE "PageContent" RENAME COLUMN "slugText" TO "slug";
ALTER TABLE "PageContent" ALTER COLUMN "slug" SET NOT NULL;

ALTER TABLE "PageContent" ADD COLUMN "path" TEXT;
UPDATE "PageContent"
SET "path" = CONCAT('/', "slug")
WHERE "path" IS NULL;
ALTER TABLE "PageContent" ALTER COLUMN "path" SET NOT NULL;

ALTER TABLE "PageContent" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 100;
UPDATE "PageContent"
SET "sortOrder" = CASE
  WHEN "slug" = 'about' THEN 10
  WHEN "slug" = 'join' THEN 20
  ELSE 100
END;

CREATE UNIQUE INDEX "PageContent_slug_key" ON "PageContent"("slug");
CREATE UNIQUE INDEX "PageContent_path_key" ON "PageContent"("path");
CREATE INDEX "PageContent_sortOrder_idx" ON "PageContent"("sortOrder");

DROP TYPE IF EXISTS "EditablePageSlug";