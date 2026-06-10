-- Add dedicated menu title for website navigation.
ALTER TABLE "PageContent"
ADD COLUMN "menuTitle" TEXT NOT NULL DEFAULT '';

UPDATE "PageContent"
SET "menuTitle" = COALESCE(NULLIF("caption", ''), "title")
WHERE "menuTitle" = '';
