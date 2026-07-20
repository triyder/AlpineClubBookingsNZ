-- #2161 (D2): operator "already invoiced" marker for one family group per season.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds ONE new table plus its indexes, foreign keys, and a raw-SQL partial
--    unique index ("one ACTIVE marker per family/season"). Purely additive — the
--    previously deployed (old-colour) Prisma client never reads this table, so it
--    keeps working unchanged during migrate -> cutover drain. No enum change, no
--    column drop/alter, no RENAME, no backfill DML, no session-clock write, and
--    no Xero/provider call. The new-colour runtime is the only writer/reader.

-- CreateTable
CREATE TABLE "FamilyGroupSeasonInvoiceMarker" (
    "id" TEXT NOT NULL,
    "familyGroupId" TEXT NOT NULL,
    "seasonYear" INTEGER NOT NULL,
    "markedByMemberId" TEXT,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FamilyGroupSeasonInvoiceMarker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FamilyGroupSeasonInvoiceMarker_familyGroupId_seasonYear_idx" ON "FamilyGroupSeasonInvoiceMarker"("familyGroupId", "seasonYear");

-- CreateIndex
CREATE INDEX "FamilyGroupSeasonInvoiceMarker_seasonYear_idx" ON "FamilyGroupSeasonInvoiceMarker"("seasonYear");

-- CreateIndex
CREATE INDEX "FamilyGroupSeasonInvoiceMarker_markedByMemberId_idx" ON "FamilyGroupSeasonInvoiceMarker"("markedByMemberId");

-- CreateIndex
CREATE INDEX "FamilyGroupSeasonInvoiceMarker_releasedByMemberId_idx" ON "FamilyGroupSeasonInvoiceMarker"("releasedByMemberId");

-- AddForeignKey
ALTER TABLE "FamilyGroupSeasonInvoiceMarker" ADD CONSTRAINT "FamilyGroupSeasonInvoiceMarker_familyGroupId_fkey" FOREIGN KEY ("familyGroupId") REFERENCES "FamilyGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyGroupSeasonInvoiceMarker" ADD CONSTRAINT "FamilyGroupSeasonInvoiceMarker_markedByMemberId_fkey" FOREIGN KEY ("markedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyGroupSeasonInvoiceMarker" ADD CONSTRAINT "FamilyGroupSeasonInvoiceMarker_releasedByMemberId_fkey" FOREIGN KEY ("releasedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Raw-SQL partial UNIQUE: at most one ACTIVE (releasedAt IS NULL) marker per
-- (familyGroupId, seasonYear). Prisma cannot express a partial unique index, so
-- it is recorded in prisma/partial-unique-indexes.tsv and enforced by
-- scripts/check-partial-indexes.sh so prisma migrate diff / db:check-drift stays
-- green. A released marker (releasedAt set) is retained and does not block a
-- fresh mark.
CREATE UNIQUE INDEX "FamilyGroupSeasonInvoiceMarker_active_unique" ON "FamilyGroupSeasonInvoiceMarker"("familyGroupId", "seasonYear") WHERE "releasedAt" IS NULL;
