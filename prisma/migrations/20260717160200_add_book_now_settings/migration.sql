-- Configurable public "Book Now" button (E3 #1929). Extends the
-- PublicContentSettings singleton with a show/hide toggle and an optional target
-- content page. Defaults preserve today's behaviour exactly: the button is shown
-- and points at the booking flow (BOOKING_FLOW). When target is PAGE,
-- "bookNowPageId" names a published PageContent; getBookNowConfig() fails open to
-- the booking flow when the page is missing/unpublished, so the button is never
-- dead. onDelete SET NULL reverts the button to the booking flow if the target
-- page is deleted rather than leaving a dangling FK.
--
-- Additive, blue/green-safe: constant-default ADD COLUMNs are metadata-only on
-- PostgreSQL 11+; PublicContentSettings is a single-row config table. No
-- hot-table or breaking-SQL matches, so no BLUE_GREEN_MIGRATION_SAFETY ledger
-- row is required.

CREATE TYPE "BookNowTarget" AS ENUM ('BOOKING_FLOW', 'PAGE');

ALTER TABLE "PublicContentSettings"
  ADD COLUMN "showBookNow" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "bookNowTarget" "BookNowTarget" NOT NULL DEFAULT 'BOOKING_FLOW',
  ADD COLUMN "bookNowPageId" TEXT;

CREATE INDEX "PublicContentSettings_bookNowPageId_idx" ON "PublicContentSettings"("bookNowPageId");

ALTER TABLE "PublicContentSettings"
  ADD CONSTRAINT "PublicContentSettings_bookNowPageId_fkey"
  FOREIGN KEY ("bookNowPageId") REFERENCES "PageContent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
