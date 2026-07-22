import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RecurrenceRule } from "@/lib/calendar-recurrence";
import { weekdayOrdinalInMonth } from "@/lib/calendar-recurrence";

const mocks = vi.hoisted(() => ({
  seriesCreate: vi.fn(),
  eventCreate: vi.fn(),
  eventCreateMany: vi.fn(),
  eventFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    calendarEventSeries: { create: mocks.seriesCreate },
    calendarEvent: {
      create: mocks.eventCreate,
      createMany: mocks.eventCreateMany,
      findFirst: mocks.eventFindFirst,
    },
  },
}));

import { createCalendarEvent } from "@/lib/calendar-service";

const baseData = {
  title: "Monthly Committee Meeting",
  location: null,
  details: null,
  allDay: false,
  isMeeting: true,
  startsAt: new Date(2026, 6, 21, 19, 30), // 3rd Tuesday of Jul 2026, 7:30pm
  endsAt: new Date(2026, 6, 21, 20, 30),
};

describe("createCalendarEvent — recurrence materialisation (regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.seriesCreate.mockResolvedValue({ id: "series-1" });
    mocks.eventCreateMany.mockResolvedValue({ count: 6 });
    mocks.eventFindFirst.mockResolvedValue({
      id: "anchor",
      title: baseData.title,
      startsAt: baseData.startsAt,
      isMeeting: true,
    });
  });

  it("materialises MANY occurrences for a 3rd-Tuesday monthly rule", async () => {
    const rule: RecurrenceRule = {
      frequency: "MONTHLY_NTH_WEEKDAY",
      interval: 1,
      endMode: "count",
      count: 6,
    };

    await createCalendarEvent({ ...baseData, recurrence: rule }, "member-1");

    expect(mocks.seriesCreate).toHaveBeenCalledOnce();
    expect(mocks.eventCreate).not.toHaveBeenCalled(); // recurring path, not single
    expect(mocks.eventCreateMany).toHaveBeenCalledOnce();

    const rows = mocks.eventCreateMany.mock.calls[0][0].data as Array<{
      startsAt: Date;
      seriesId: string;
      isMeeting: boolean;
      meetingRoom: string | null;
    }>;

    // The core regression: a recurrence rule must produce MORE THAN ONE row.
    expect(rows.length).toBe(6);

    const anchorNth = weekdayOrdinalInMonth(baseData.startsAt);
    for (const row of rows) {
      expect(row.seriesId).toBe("series-1");
      // Every occurrence lands on the same nth weekday (3rd Tuesday).
      expect(row.startsAt.getDay()).toBe(baseData.startsAt.getDay());
      expect(weekdayOrdinalInMonth(row.startsAt)).toBe(anchorNth);
      // A meeting series gives each occurrence its own room.
      expect(row.isMeeting).toBe(true);
      expect(row.meetingRoom).toBeTruthy();
    }

    // Distinct rooms per occurrence (no shared/guessable link).
    const rooms = new Set(rows.map((r) => r.meetingRoom));
    expect(rooms.size).toBe(rows.length);
  });

  it("creates a single row (no series) for a non-recurring event", async () => {
    mocks.eventCreate.mockResolvedValue({ id: "one-off" });

    await createCalendarEvent({ ...baseData, recurrence: null }, "member-1");

    expect(mocks.eventCreate).toHaveBeenCalledOnce();
    expect(mocks.seriesCreate).not.toHaveBeenCalled();
    expect(mocks.eventCreateMany).not.toHaveBeenCalled();
  });
});
