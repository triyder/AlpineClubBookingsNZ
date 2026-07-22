-- Club events calendar (committee meetings, working bees, social events, ...).
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds ONE new standalone table plus its start-time index. Purely additive —
--    the previously deployed (old-colour) Prisma client never reads this table,
--    so it keeps working unchanged during migrate -> cutover drain. No enum
--    change, no column drop/alter, no RENAME, no backfill DML, no foreign key,
--    no session-clock write, and no external provider call. The new-colour
--    runtime is the only writer/reader.

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "details" TEXT,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "isMeeting" BOOLEAN NOT NULL DEFAULT false,
    "meetingRoom" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarEvent_startsAt_idx" ON "CalendarEvent"("startsAt");
