import { prisma } from "@/lib/prisma";
import { MAX_OCCURRENCES } from "@/lib/calendar-recurrence";
import {
  buildOccurrenceRows,
  type ResolvedEventData,
} from "@/lib/calendar-occurrences";
import { lockCalendarSeries } from "@/lib/calendar-service";
import { startOfClubDay, type CalendarDate } from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";

/**
 * What a work party puts on the calendar (fork #118): one all-day entry per
 * club day in `days`, which the caller derives from the work party's date-only
 * window. More than one day is stored as a daily series so the calendar shows
 * the ↻ marker and the entries move together; one day is a standalone entry.
 */
export interface WorkPartyCalendarEntry {
  title: string;
  location: string | null;
  details: string | null;
  days: CalendarDate[];
}

/**
 * Replace every calendar entry linked to a work party with `entry`, or remove
 * them all when `entry` is null. The ONE writer of
 * `CalendarEvent.workPartyEventId` (fork #118): the work-party routes call it
 * on create, edit, delete and "Add to calendar", and the calendar's own edit
 * and delete refuse linked entries, so the two cannot drift.
 *
 * Delete-and-recreate rather than an in-place edit: a work party's dates can
 * move in either direction and the entries carry nothing of their own (no
 * meeting room, no per-occurrence exception), so regenerating is the honest
 * shape. It runs in one transaction under the existing calendar-series lock
 * with a `work-party:` key, so two officers saving the same work party cannot
 * interleave and duplicate its entries. Capped at MAX_OCCURRENCES days, the
 * calendar's own series limit.
 *
 * Returns the number of entries now linked.
 */
export async function replaceWorkPartyCalendarEvents(
  workPartyEventId: string,
  entry: WorkPartyCalendarEntry | null,
  actorId: string,
): Promise<number> {
  const zone = entry ? await clubTimeZone() : null;
  return prisma.$transaction(async (tx) => {
    await lockCalendarSeries(tx, `work-party:${workPartyEventId}`);
    const linked = await tx.calendarEvent.findMany({
      where: { workPartyEventId },
      select: { seriesId: true },
    });
    const seriesIds = [
      ...new Set(
        linked
          .map((row) => row.seriesId)
          .filter((id): id is string => id !== null),
      ),
    ];
    await tx.calendarEvent.deleteMany({ where: { workPartyEventId } });
    if (seriesIds.length > 0) {
      await tx.calendarEventSeries.deleteMany({
        where: { id: { in: seriesIds }, events: { none: {} } },
      });
    }
    if (!entry || !zone) return 0;

    const starts = entry.days
      .slice(0, MAX_OCCURRENCES)
      .map((day) => startOfClubDay(day, zone));
    const [firstStart] = starts;
    if (!firstStart) return 0;
    const template: ResolvedEventData = {
      title: entry.title,
      location: entry.location,
      details: entry.details,
      allDay: true,
      isMeeting: false,
      startsAt: firstStart,
      endsAt: null,
      recurrence: null,
    };

    if (starts.length === 1) {
      await tx.calendarEvent.create({
        data: {
          title: template.title,
          location: template.location,
          details: template.details,
          allDay: true,
          startsAt: firstStart,
          endsAt: null,
          isMeeting: false,
          meetingRoom: null,
          createdById: actorId,
          workPartyEventId,
        },
      });
      return 1;
    }

    const series = await tx.calendarEventSeries.create({
      data: {
        frequency: "DAILY",
        interval: 1,
        until: null,
        count: starts.length,
        createdById: actorId,
      },
    });
    const rows = buildOccurrenceRows(starts, template, series.id, actorId).map(
      (row) => ({ ...row, workPartyEventId }),
    );
    await tx.calendarEvent.createMany({ data: rows });
    return rows.length;
  });
}
