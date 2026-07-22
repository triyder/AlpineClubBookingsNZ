-- #2095 (C6): cross-process running-state + history for the managed database
-- backup, honoured by both the nightly cron and the /admin/backups run-now
-- action.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds ONE new standalone cold table with two btree indexes. Purely
--    additive — the previously deployed (old-colour) Prisma client has no
--    BackupRun model, so it never reads or writes this table and keeps working
--    unchanged during migrate -> cutover drain. No enum change, no column
--    drop/alter on an existing table, no RENAME, no backfill DML, no foreign
--    key, no session-clock DML on an existing hot table, and no provider call.
--    The new-colour runtime is the only writer (the backup claim path) and
--    reader (the admin backups page). The table is brand-new and absent from
--    HOT_TABLE_SQL_REGEX.

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER,
    "resultSummary" JSONB,
    "error" TEXT,
    "triggeredByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupRun_status_idx" ON "BackupRun"("status");

-- CreateIndex
CREATE INDEX "BackupRun_startedAt_idx" ON "BackupRun"("startedAt");
