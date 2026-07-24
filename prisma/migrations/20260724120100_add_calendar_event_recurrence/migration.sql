-- Recurring calendar events (#calendar-recurring).
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds a new enum + a new standalone series table, and TWO new nullable/
--    defaulted columns on CalendarEvent (seriesId, detachedFromSeries) plus an
--    index and a SET NULL foreign key. Purely additive — the previously
--    deployed (old-colour) client selects an explicit CalendarEvent column set
--    that does not name the new columns, so it keeps working unchanged during
--    migrate -> cutover drain. No column drop/alter, no RENAME, no backfill DML,
--    no session-clock write, and no external provider call.

-- CreateEnum
CREATE TYPE "CalendarRecurrenceFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY_DAY_OF_MONTH', 'MONTHLY_NTH_WEEKDAY');

-- CreateTable
CREATE TABLE "CalendarEventSeries" (
    "id" TEXT NOT NULL,
    "frequency" "CalendarRecurrenceFrequency" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "until" TIMESTAMP(3),
    "count" INTEGER,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEventSeries_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN     "seriesId" TEXT,
ADD COLUMN     "detachedFromSeries" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "CalendarEvent_seriesId_idx" ON "CalendarEvent"("seriesId");

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "CalendarEventSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
