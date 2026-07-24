import { randomUUID } from "crypto";
import type { CalendarEvent, CalendarEventSeries, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CalendarEditScope } from "@/lib/calendar-events";
import {
  generateOccurrenceStarts,
  type RecurrenceRule,
} from "@/lib/calendar-recurrence";

/**
 * Calendar create / update / delete, including recurrence materialisation and
 * the single-occurrence vs whole-series edit semantics (#calendar-recurring).
 *
 * A recurring event is stored as one CalendarEvent row per occurrence, sharing
 * a CalendarEventSeries. Editing scope:
 *  - "single": only the clicked occurrence changes; if it belonged to a series
 *    it is marked detachedFromSeries so later series edits/deletes skip it.
 *  - "series": applies to every NON-detached occurrence. Detail/time-only
 *    changes are propagated in place (each occurrence keeps its own date);
 *    changing the recurrence pattern (or the anchor date) regenerates the whole
 *    series from the edited occurrence, preserving detached exceptions.
 */

/** Field/time template shared by all occurrences of one create/edit. */
interface ResolvedEventData {
  title: string;
  location: string | null;
  details: string | null;
  allDay: boolean;
  isMeeting: boolean;
  startsAt: Date;
  endsAt: Date | null;
  recurrence: RecurrenceRule | null;
}

function durationMsOf(startsAt: Date, endsAt: Date | null): number | null {
  return endsAt ? endsAt.getTime() - startsAt.getTime() : null;
}

function nextMeetingRoom(
  isMeeting: boolean,
  existingRoom: string | null,
): string | null {
  if (!isMeeting) return null;
  return existingRoom ?? randomUUID();
}

/** Local Y-M-D key, for comparing "which day" two instants fall on. */
function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Combine a target day with a template's time-of-day (or midnight, all-day). */
function withTimeOfDay(day: Date, time: Date, allDay: boolean): Date {
  if (allDay) {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  }
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    time.getHours(),
    time.getMinutes(),
    time.getSeconds(),
    time.getMilliseconds(),
  );
}

function seriesUntil(rule: RecurrenceRule): Date | null {
  return rule.endMode === "until" && rule.until ? new Date(rule.until) : null;
}

function seriesCount(rule: RecurrenceRule): number | null {
  return rule.endMode === "count" && rule.count ? rule.count : null;
}

/** Does a stored series row already match this rule (frequency/interval/end)? */
function seriesMatchesRule(
  series: CalendarEventSeries,
  rule: RecurrenceRule,
): boolean {
  const storedUntilKey = series.until ? localDayKey(series.until) : null;
  const ruleUntil = seriesUntil(rule);
  const ruleUntilKey = ruleUntil ? localDayKey(ruleUntil) : null;
  return (
    series.frequency === rule.frequency &&
    series.interval === rule.interval &&
    storedUntilKey === ruleUntilKey &&
    (series.count ?? null) === seriesCount(rule)
  );
}

function buildOccurrenceRows(
  starts: Date[],
  data: ResolvedEventData,
  seriesId: string,
  actorId: string,
): Prisma.CalendarEventCreateManyInput[] {
  const durationMs = durationMsOf(data.startsAt, data.endsAt);
  return starts.map((start) => ({
    title: data.title,
    location: data.location,
    details: data.details,
    allDay: data.allDay,
    startsAt: start,
    endsAt:
      data.allDay || durationMs == null
        ? null
        : new Date(start.getTime() + durationMs),
    isMeeting: data.isMeeting,
    // Each occurrence gets its own unguessable room, so a leaked link never
    // opens a different week's meeting.
    meetingRoom: data.isMeeting ? randomUUID() : null,
    createdById: actorId,
    seriesId,
    detachedFromSeries: false,
  }));
}

/** Prisma client or an interactive-transaction client. */
type Db = typeof prisma | Prisma.TransactionClient;

/**
 * Serialize concurrent whole-series mutations. Without this, two editors saving
 * the same recurring series can interleave their delete-and-regenerate under
 * Read Committed and duplicate or drop occurrences. Keyed per-series (namespaced
 * so calendar keys can't false-share with the per-lodge capacity lock), the lock
 * releases at transaction end — mirrors lockLodgeForCapacity in
 * src/lib/capacity.ts. $executeRaw (not $queryRaw): pg_advisory_xact_lock
 * returns void, which the driver adapter cannot deserialize as a result row.
 */
async function lockCalendarSeries(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  seriesId: string,
): Promise<void> {
  const key = `calendar-series:${seriesId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

async function createSeriesWithOccurrences(
  data: ResolvedEventData & { recurrence: RecurrenceRule },
  actorId: string,
  db: Db = prisma,
): Promise<CalendarEvent> {
  const series = await db.calendarEventSeries.create({
    data: {
      frequency: data.recurrence.frequency,
      interval: data.recurrence.interval,
      until: seriesUntil(data.recurrence),
      count: seriesCount(data.recurrence),
      createdById: actorId,
    },
  });

  const starts = generateOccurrenceStarts(data.startsAt, data.recurrence);
  await db.calendarEvent.createMany({
    data: buildOccurrenceRows(starts, data, series.id, actorId),
  });

  // The anchor is the first (earliest) occurrence — used for the audit log
  // and the API response.
  const anchor = await db.calendarEvent.findFirst({
    where: { seriesId: series.id },
    orderBy: { startsAt: "asc" },
  });
  // createMany always inserts at least the anchor, so this is non-null; the
  // fallback keeps the type honest.
  return anchor as CalendarEvent;
}

/** Create a one-off or recurring event. Returns the (anchor) event. */
export async function createCalendarEvent(
  data: ResolvedEventData,
  actorId: string,
): Promise<CalendarEvent> {
  if (!data.recurrence) {
    return prisma.calendarEvent.create({
      data: {
        title: data.title,
        location: data.location,
        details: data.details,
        allDay: data.allDay,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        isMeeting: data.isMeeting,
        meetingRoom: data.isMeeting ? randomUUID() : null,
        createdById: actorId,
      },
    });
  }
  return createSeriesWithOccurrences(
    { ...data, recurrence: data.recurrence },
    actorId,
  );
}

type EventWithSeries = CalendarEvent & { series: CalendarEventSeries | null };

async function updateSingleOccurrence(
  existing: CalendarEvent,
  data: ResolvedEventData,
): Promise<CalendarEvent> {
  return prisma.calendarEvent.update({
    where: { id: existing.id },
    data: {
      title: data.title,
      location: data.location,
      details: data.details,
      allDay: data.allDay,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      isMeeting: data.isMeeting,
      meetingRoom: nextMeetingRoom(data.isMeeting, existing.meetingRoom),
      // A per-occurrence edit becomes an exception so later series edits skip it.
      detachedFromSeries: existing.seriesId ? true : existing.detachedFromSeries,
    },
  });
}

/**
 * Series edit with the SAME recurrence pattern and anchor day: push the new
 * details + time-of-day onto every non-detached occurrence, keeping each one's
 * own date.
 */
async function propagateSeriesFieldChanges(
  seriesId: string,
  data: ResolvedEventData,
): Promise<void> {
  const durationMs = durationMsOf(data.startsAt, data.endsAt);
  // Read the occurrence set UNDER the per-series lock (inside the transaction),
  // so a concurrent regenerate cannot delete rows out from under this update.
  await prisma.$transaction(async (tx) => {
    await lockCalendarSeries(tx, seriesId);
    const occurrences = await tx.calendarEvent.findMany({
      where: { seriesId, detachedFromSeries: false },
      select: { id: true, startsAt: true, meetingRoom: true },
    });
    for (const occ of occurrences) {
      const start = withTimeOfDay(occ.startsAt, data.startsAt, data.allDay);
      const endsAt =
        data.allDay || durationMs == null
          ? null
          : new Date(start.getTime() + durationMs);
      await tx.calendarEvent.update({
        where: { id: occ.id },
        data: {
          title: data.title,
          location: data.location,
          details: data.details,
          allDay: data.allDay,
          startsAt: start,
          endsAt,
          isMeeting: data.isMeeting,
          meetingRoom: nextMeetingRoom(data.isMeeting, occ.meetingRoom),
        },
      });
    }
  });
}

/**
 * Series edit that CHANGES the pattern (or the anchor day): rewrite the rule and
 * regenerate every non-detached occurrence from the edited occurrence as the new
 * anchor. Detached exceptions are left untouched.
 */
async function regenerateSeries(
  series: CalendarEventSeries,
  data: ResolvedEventData & { recurrence: RecurrenceRule },
  actorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockCalendarSeries(tx, series.id);
    await tx.calendarEventSeries.update({
      where: { id: series.id },
      data: {
        frequency: data.recurrence.frequency,
        interval: data.recurrence.interval,
        until: seriesUntil(data.recurrence),
        count: seriesCount(data.recurrence),
      },
    });
    await tx.calendarEvent.deleteMany({
      where: { seriesId: series.id, detachedFromSeries: false },
    });
    const starts = generateOccurrenceStarts(data.startsAt, data.recurrence);
    await tx.calendarEvent.createMany({
      data: buildOccurrenceRows(starts, data, series.id, actorId),
    });
  });
}

/**
 * Series edit that turns recurrence OFF: keep the edited occurrence as a
 * standalone event and drop the rest of the series.
 */
async function collapseSeriesToSingle(
  existing: EventWithSeries,
  data: ResolvedEventData,
): Promise<CalendarEvent> {
  return prisma.$transaction(async (tx) => {
    await lockCalendarSeries(tx, existing.seriesId!);
    // Remove every other occurrence; detach the survivor from the series.
    await tx.calendarEvent.deleteMany({
      where: { seriesId: existing.seriesId!, id: { not: existing.id } },
    });
    const updated = await tx.calendarEvent.update({
      where: { id: existing.id },
      data: {
        title: data.title,
        location: data.location,
        details: data.details,
        allDay: data.allDay,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        isMeeting: data.isMeeting,
        meetingRoom: nextMeetingRoom(data.isMeeting, existing.meetingRoom),
        seriesId: null,
        detachedFromSeries: false,
      },
    });
    await tx.calendarEventSeries.delete({ where: { id: existing.seriesId! } });
    return updated;
  });
}

export interface CalendarUpdateResult {
  anchor: CalendarEvent;
  scope: CalendarEditScope;
}

/**
 * Update an event. `scope` only matters when the event belongs to a series;
 * a standalone event is always edited in place. Returns null when the id is
 * unknown (the route turns that into a 404).
 */
export async function updateCalendarEvent(
  id: string,
  data: ResolvedEventData,
  scope: CalendarEditScope,
  actorId: string,
): Promise<CalendarUpdateResult | null> {
  const existing = (await prisma.calendarEvent.findUnique({
    where: { id },
    include: { series: true },
  })) as EventWithSeries | null;
  if (!existing) return null;

  // Converting a standalone (non-recurring) event INTO a recurring series:
  // replace the single row with a freshly generated series anchored at the
  // edited start. Runs before the single-edit path so "open the event, set it
  // to repeat, save" works without deleting and recreating.
  if (!existing.seriesId && data.recurrence) {
    const anchor = await prisma.$transaction(async (tx) => {
      // Serialize concurrent "convert this standalone event into a series" saves
      // on the same row (keyed by the event id, since no series exists yet).
      await lockCalendarSeries(tx, id);
      await tx.calendarEvent.delete({ where: { id } });
      return createSeriesWithOccurrences(
        { ...data, recurrence: data.recurrence as RecurrenceRule },
        actorId,
        tx,
      );
    });
    return { anchor, scope: "series" };
  }

  // Standalone event, or a per-occurrence edit: change just this row.
  if (!existing.seriesId || !existing.series || scope === "single") {
    return { anchor: await updateSingleOccurrence(existing, data), scope: "single" };
  }

  // Series edit that removes recurrence entirely.
  if (!data.recurrence) {
    return {
      anchor: await collapseSeriesToSingle(existing, data),
      scope: "series",
    };
  }

  const dateChanged =
    localDayKey(existing.startsAt) !== localDayKey(data.startsAt);
  const patternChanged =
    dateChanged || !seriesMatchesRule(existing.series, data.recurrence);

  if (patternChanged) {
    await regenerateSeries(
      existing.series,
      { ...data, recurrence: data.recurrence },
      actorId,
    );
  } else {
    await propagateSeriesFieldChanges(existing.seriesId, data);
  }

  // Return the (possibly regenerated) anchor for the response.
  const anchor = await prisma.calendarEvent.findFirst({
    where: { seriesId: existing.seriesId },
    orderBy: { startsAt: "asc" },
  });
  return { anchor: (anchor ?? existing) as CalendarEvent, scope: "series" };
}

export interface CalendarDeleteResult {
  title: string;
  scope: CalendarEditScope;
  deletedCount: number;
}

/**
 * Delete an event. `scope: "series"` removes every occurrence of the series
 * (and the series row); "single" removes just this occurrence, tidying up an
 * emptied series. Returns null when the id is unknown.
 */
export async function deleteCalendarEvent(
  id: string,
  scope: CalendarEditScope,
): Promise<CalendarDeleteResult | null> {
  const existing = await prisma.calendarEvent.findUnique({ where: { id } });
  if (!existing) return null;

  if (scope === "series" && existing.seriesId) {
    const seriesId = existing.seriesId;
    const result = await prisma.$transaction(async (tx) => {
      await lockCalendarSeries(tx, seriesId);
      const deleted = await tx.calendarEvent.deleteMany({ where: { seriesId } });
      await tx.calendarEventSeries.delete({ where: { id: seriesId } });
      return deleted.count;
    });
    return { title: existing.title, scope: "series", deletedCount: result };
  }

  await prisma.calendarEvent.delete({ where: { id } });

  // Drop an emptied series so no orphan rule row lingers.
  if (existing.seriesId) {
    const remaining = await prisma.calendarEvent.count({
      where: { seriesId: existing.seriesId },
    });
    if (remaining === 0) {
      await prisma.calendarEventSeries
        .delete({ where: { id: existing.seriesId } })
        .catch(() => {});
    }
  }

  return { title: existing.title, scope: "single", deletedCount: 1 };
}

export type { ResolvedEventData };
