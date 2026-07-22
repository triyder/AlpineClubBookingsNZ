import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { canManageCalendarEvents } from "@/lib/calendar-access";
import { createCalendarEvent } from "@/lib/calendar-service";
import {
  calendarEventInputSchema,
  resolveCalendarEventDates,
  serializeCalendarEvent,
} from "@/lib/calendar-events";

// Widest window a single list request may span, guarding against an unbounded
// scan if a client sends a silly range. A month view needs ~6 weeks; a year of
// slack is plenty.
const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

function parseRangeParam(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * List calendar events. Readable by any active member (the calendar is
 * club-wide, read-only for ordinary members). Accepts `from` / `to` ISO bounds
 * (the visible month's grid range); defaults to a broad window around now when
 * omitted. Also returns `canManage` so the client renders edit controls only
 * for committee members and lodge-edit admins.
 */
export async function GET(req: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const now = Date.now();
  const from =
    parseRangeParam(url.searchParams.get("from")) ??
    new Date(now - 90 * 24 * 60 * 60 * 1000);
  let to =
    parseRangeParam(url.searchParams.get("to")) ??
    new Date(now + 275 * 24 * 60 * 60 * 1000);
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
    to = new Date(from.getTime() + MAX_RANGE_MS);
  }

  const [events, canManage] = await Promise.all([
    prisma.calendarEvent.findMany({
      // An event overlaps the window when it starts before the window ends and
      // (for timed events) ends after the window starts. All-day / open-ended
      // events (endsAt null) are matched on their start alone.
      where: {
        startsAt: { lte: to },
        OR: [{ endsAt: null }, { endsAt: { gte: from } }],
      },
      orderBy: { startsAt: "asc" },
      include: { series: true },
    }),
    canManageCalendarEvents(guard.session.user),
  ]);

  return NextResponse.json({
    events: events.map(serializeCalendarEvent),
    canManage,
  });
}

/**
 * Create a calendar event. Restricted to committee members and lodge-edit
 * admins (see canManageCalendarEvents). A meeting event is assigned an
 * unguessable MiroTalk room slug server-side so the join link cannot be
 * predicted from the title or id.
 */
export async function POST(req: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  if (!(await canManageCalendarEvents(guard.session.user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const json = await parseJsonRequestBody(req);
  if (!json.ok) return json.response;

  const parsed = calendarEventInputSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const dates = resolveCalendarEventDates(parsed.data);
  if ("error" in dates) {
    return NextResponse.json({ error: dates.error }, { status: 400 });
  }

  const recurrence = parsed.data.recurrence ?? null;
  if (recurrence) {
    if (recurrence.endMode === "until" && !recurrence.until) {
      return NextResponse.json(
        { error: "An end date is required for a recurrence that ends on a date." },
        { status: 400 },
      );
    }
    if (recurrence.endMode === "count" && !recurrence.count) {
      return NextResponse.json(
        { error: "A number of occurrences is required for this recurrence." },
        { status: 400 },
      );
    }
  }

  const event = await createCalendarEvent(
    {
      title: parsed.data.title,
      location: parsed.data.location?.trim() || null,
      details: parsed.data.details?.trim() || null,
      allDay: parsed.data.allDay,
      isMeeting: parsed.data.isMeeting,
      startsAt: dates.startsAt,
      endsAt: dates.endsAt,
      recurrence,
    },
    guard.session.user.id,
  );

  logAudit({
    action: "calendar.event.create",
    memberId: guard.session.user.id,
    targetId: event.id,
    entityType: "CalendarEvent",
    category: "admin",
    outcome: "success",
    summary: recurrence ? "Recurring calendar event created" : "Calendar event created",
    details: `Created calendar event: ${event.title}`,
    metadata: {
      title: event.title,
      startsAt: event.startsAt.toISOString(),
      allDay: event.allDay,
      isMeeting: event.isMeeting,
      recurring: Boolean(recurrence),
      frequency: recurrence?.frequency ?? null,
    },
  });

  return NextResponse.json(
    { event: serializeCalendarEvent(event) },
    { status: 201 },
  );
}
