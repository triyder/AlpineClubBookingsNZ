-- Add reminder state for membership nomination recovery. The columns are
-- additive so old application code can continue to ignore them during
-- blue/green cutover.
ALTER TABLE "NominationToken"
  ADD COLUMN "reminderCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastSentAt" TIMESTAMP(3);

UPDATE "NominationToken"
SET "lastSentAt" = "createdAt"
WHERE "lastSentAt" IS NULL;

CREATE INDEX "NominationToken_confirmedAt_expiresAt_idx"
  ON "NominationToken"("confirmedAt", "expiresAt");
