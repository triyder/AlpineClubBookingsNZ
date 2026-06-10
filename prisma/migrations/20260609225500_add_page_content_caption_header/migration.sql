-- Add page hero caption and header text fields.
ALTER TABLE "PageContent"
ADD COLUMN "caption" TEXT NOT NULL DEFAULT '';

ALTER TABLE "PageContent"
ADD COLUMN "headerText" TEXT NOT NULL DEFAULT '';

UPDATE "PageContent"
SET "caption" = CASE
  WHEN "slug" = 'about' THEN 'About the Club'
  WHEN "slug" = 'join' THEN 'Join the Club'
  ELSE ''
END,
"headerText" = CASE
  WHEN "slug" = 'about' THEN 'Learn about our club history, values, and alpine community.'
  WHEN "slug" = 'join' THEN 'Nomination by two current members, induction process, and membership details.'
  ELSE ''
END;