import { z } from "zod";
import type { CalendarEvent, CalendarEventSeries } from "@prisma/client";
import {
  CALENDAR_RECURRENCE_FREQUENCIES,
  MAX_OCCURRENCES,
  type RecurrenceEndMode,
} from "@/lib/calendar-recurrence";

/**
 * Base URL of the self-hosted MiroTalk instance used for meeting events.
 * Environment-specific by design: `http://localhost:3010` in local dev, the
 * public meeting host (e.g. `https://meet.<domain>`) in production, set via the
 * `NEXT_PUBLIC_MIROTALK_URL` build-time env var. A meeting event stores only its
 * room slug (`meetingRoom`); the join URL is derived here so the same event row
 * resolves to the right host in each environment.
 */
export const MIROTALK_BASE_URL =
  process.env.NEXT_PUBLIC_MIROTALK_URL?.trim() || "http://localhost:3010";

/** Build a MiroTalk join URL for a stored room slug. */
export function buildMeetingJoinUrl(room: string): string {
  return `${MIROTALK_BASE_URL.replace(/\/+$/, "")}/join/${encodeURIComponent(room)}`;
}

/**
 * Request body for creating / updating a calendar event. Dates arrive as ISO
 * strings the client builds from the date + time (or all-day) inputs; they are
 * range-validated in {@link resolveCalendarEventDates}, not here, so a bad
 * end-before-start pairing yields a specific message rather than a generic zod
 * failure.
 */
/** Recurrence rule sent with a create / series-edit request; null = one-off. */
export const recurrenceInputSchema = z.object({
  frequency: z.enum(CALENDAR_RECURRENCE_FREQUENCIES),
  interval: z.number().int().min(1).max(52),
  endMode: z.enum(["never", "until", "count"]),
  until: z.string().nullish(),
  count: z.number().int().min(1).max(MAX_OCCURRENCES).nullish(),
});

export const calendarEventInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  location: z.string().trim().max(200).nullish(),
  details: z.string().trim().max(5000).nullish(),
  allDay: z.boolean(),
  startsAt: z.string().min(1, "Start date is required"),
  endsAt: z.string().nullish(),
  isMeeting: z.boolean(),
  recurrence: recurrenceInputSchema.nullish(),
});

export type CalendarEventInput = z.infer<typeof calendarEventInputSchema>;

/** Which occurrences a series-event edit or delete applies to. */
export const calendarEditScopeSchema = z.enum(["single", "series"]);
export type CalendarEditScope = z.infer<typeof calendarEditScopeSchema>;

/**
 * Parse and range-check the ISO date strings. Returns concrete Dates, or an
 * `error` message for the 400. An all-day event keeps `endsAt` null; a timed
 * event may carry an end that must not precede the start.
 */
export function resolveCalendarEventDates(
  input: Pick<CalendarEventInput, "startsAt" | "endsAt" | "allDay">,
): { startsAt: Date; endsAt: Date | null } | { error: string } {
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    return { error: "Invalid start date/time" };
  }

  if (input.allDay || !input.endsAt) {
    return { startsAt, endsAt: null };
  }

  const endsAt = new Date(input.endsAt);
  if (Number.isNaN(endsAt.getTime())) {
    return { error: "Invalid end date/time" };
  }
  if (endsAt.getTime() < startsAt.getTime()) {
    return { error: "End time must be on or after the start time" };
  }
  return { startsAt, endsAt };
}

/** The recurrence rule of the event's series, in the client's input shape. */
export type RecurrenceSummaryDTO = {
  frequency: (typeof CALENDAR_RECURRENCE_FREQUENCIES)[number];
  interval: number;
  endMode: RecurrenceEndMode;
  until: string | null;
  count: number | null;
};

export function recurrenceSummaryFromSeries(
  series: CalendarEventSeries,
): RecurrenceSummaryDTO {
  const endMode: RecurrenceEndMode = series.until
    ? "until"
    : series.count != null
      ? "count"
      : "never";
  return {
    frequency: series.frequency,
    interval: series.interval,
    endMode,
    until: series.until ? series.until.toISOString() : null,
    count: series.count,
  };
}

/** Wire shape a calendar event takes on the client. */
export type CalendarEventDTO = {
  id: string;
  title: string;
  location: string | null;
  details: string | null;
  allDay: boolean;
  startsAt: string;
  endsAt: string | null;
  isMeeting: boolean;
  meetingUrl: string | null;
  seriesId: string | null;
  detachedFromSeries: boolean;
  /** The series rule when this event recurs (null for a one-off). */
  recurrence: RecurrenceSummaryDTO | null;
};

/** Serialise a stored event for the API, resolving the meeting join URL. */
export function serializeCalendarEvent(
  event: CalendarEvent & { series?: CalendarEventSeries | null },
): CalendarEventDTO {
  return {
    id: event.id,
    title: event.title,
    location: event.location,
    details: event.details,
    allDay: event.allDay,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt ? event.endsAt.toISOString() : null,
    isMeeting: event.isMeeting,
    meetingUrl:
      event.isMeeting && event.meetingRoom
        ? buildMeetingJoinUrl(event.meetingRoom)
        : null,
    seriesId: event.seriesId,
    detachedFromSeries: event.detachedFromSeries,
    recurrence: event.series
      ? recurrenceSummaryFromSeries(event.series)
      : null,
  };
}
