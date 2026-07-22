import { describe, it, expect } from "vitest";
import type { CalendarEvent } from "@prisma/client";
import {
  buildMeetingJoinUrl,
  resolveCalendarEventDates,
  serializeCalendarEvent,
} from "@/lib/calendar-events";

describe("resolveCalendarEventDates", () => {
  it("returns start with null end for an all-day event", () => {
    const result = resolveCalendarEventDates({
      startsAt: "2026-08-01T00:00:00.000Z",
      endsAt: "2026-08-01T05:00:00.000Z",
      allDay: true,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.endsAt).toBeNull();
    expect(result.startsAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("keeps a valid timed end", () => {
    const result = resolveCalendarEventDates({
      startsAt: "2026-08-01T19:00:00.000Z",
      endsAt: "2026-08-01T20:30:00.000Z",
      allDay: false,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.endsAt?.toISOString()).toBe("2026-08-01T20:30:00.000Z");
  });

  it("rejects an end before the start", () => {
    const result = resolveCalendarEventDates({
      startsAt: "2026-08-01T20:00:00.000Z",
      endsAt: "2026-08-01T19:00:00.000Z",
      allDay: false,
    });
    expect("error" in result).toBe(true);
  });

  it("rejects an unparseable start", () => {
    const result = resolveCalendarEventDates({
      startsAt: "not-a-date",
      endsAt: null,
      allDay: false,
    });
    expect("error" in result).toBe(true);
  });
});

describe("buildMeetingJoinUrl", () => {
  it("builds a /join/<room> URL from the configured base", () => {
    // Default base is http://localhost:3010 in tests (no env override).
    expect(buildMeetingJoinUrl("room-abc")).toBe(
      "http://localhost:3010/join/room-abc",
    );
  });
});

describe("serializeCalendarEvent", () => {
  const base: CalendarEvent = {
    id: "evt-1",
    title: "Committee meeting",
    location: "Clubrooms",
    details: null,
    allDay: false,
    startsAt: new Date("2026-08-01T19:00:00.000Z"),
    endsAt: new Date("2026-08-01T20:00:00.000Z"),
    isMeeting: false,
    meetingRoom: null,
    createdById: "member-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    seriesId: null,
    detachedFromSeries: false,
  };

  it("omits a join URL for a non-meeting event", () => {
    expect(serializeCalendarEvent(base).meetingUrl).toBeNull();
  });

  it("resolves the join URL for a meeting event with a room", () => {
    const dto = serializeCalendarEvent({
      ...base,
      isMeeting: true,
      meetingRoom: "xyz",
    });
    expect(dto.meetingUrl).toBe("http://localhost:3010/join/xyz");
  });

  it("has no join URL when a meeting flag lacks a room slug", () => {
    const dto = serializeCalendarEvent({
      ...base,
      isMeeting: true,
      meetingRoom: null,
    });
    expect(dto.meetingUrl).toBeNull();
  });
});
