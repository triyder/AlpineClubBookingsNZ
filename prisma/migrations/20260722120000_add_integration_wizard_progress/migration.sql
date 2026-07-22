-- #2080 (C2): per-wizard cursor/progress for the reusable guided-provider setup
-- shell.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds ONE new standalone table plus a compound-free unique on wizardId and a
--    single index. Purely additive — the previously deployed (old-colour) Prisma
--    client never reads this table, so it keeps working unchanged during
--    migrate -> cutover drain. No enum change, no column drop/alter, no RENAME,
--    no backfill DML, no foreign key, no session-clock write, and no
--    Xero/provider call. The new-colour runtime is the only writer/reader.

-- CreateTable
CREATE TABLE "IntegrationWizardProgress" (
    "id" TEXT NOT NULL,
    "wizardId" TEXT NOT NULL,
    "currentStepId" TEXT NOT NULL,
    "completedStepIds" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByMemberId" TEXT,

    CONSTRAINT "IntegrationWizardProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationWizardProgress_wizardId_key" ON "IntegrationWizardProgress"("wizardId");

-- CreateIndex
CREATE INDEX "IntegrationWizardProgress_updatedAt_idx" ON "IntegrationWizardProgress"("updatedAt");
