import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RecurrenceRule } from "@/lib/calendar-recurrence";

// In-memory Prisma fake for CalendarEvent / CalendarEventSeries. It implements
// just the query surface calendar-service.ts uses, with enough where-clause
// semantics (id, seriesId, detachedFromSeries, id:{not}) to exercise the real
// single-vs-series edit logic — including the headline "edit one occurrence,
// then edit the whole series, and the single-occurrence exception survives"
// promise, which had no coverage. $transaction runs the interactive callback
// against the same store; $executeRaw (the per-series advisory lock) is a no-op.
const h = vi.hoisted(() => {
  interface EventRow {
    id: string;
    title: string;
    location: string | null;
    details: string | null;
    allDay: boolean;
    startsAt: Date;
    endsAt: Date | null;
    isMeeting: boolean;
    meetingRoom: string | null;
    createdById: string;
    createdAt: Date;
    updatedAt: Date;
    seriesId: string | null;
    detachedFromSeries: boolean;
  }
  interface SeriesRow {
    id: string;
    frequency: string;
    interval: number;
    until: Date | null;
    count: number | null;
    createdById: string;
    createdAt: Date;
    updatedAt: Date;
  }

  const events = new Map<string, EventRow>();
  const series = new Map<string, SeriesRow>();
  let seq = 0;
  const nextId = (p: string) => `${p}-${(seq += 1)}`;

  function matchEvent(row: EventRow, where: Record<string, unknown> = {}): boolean {
    if (where.id !== undefined) {
      if (typeof where.id === "object" && where.id !== null) {
        if (row.id === (where.id as { not: string }).not) return false;
      } else if (row.id !== where.id) {
        return false;
      }
    }
    if (where.seriesId !== undefined && row.seriesId !== where.seriesId) {
      return false;
    }
    if (
      where.detachedFromSeries !== undefined &&
      row.detachedFromSeries !== where.detachedFromSeries
    ) {
      return false;
    }
    return true;
  }

  function makeEventRow(data: Record<string, unknown>): EventRow {
    const now = new Date();
    return {
      id: (data.id as string) ?? nextId("evt"),
      title: data.title as string,
      location: (data.location as string | null) ?? null,
      details: (data.details as string | null) ?? null,
      allDay: (data.allDay as boolean) ?? false,
      startsAt: data.startsAt as Date,
      endsAt: (data.endsAt as Date | null) ?? null,
      isMeeting: (data.isMeeting as boolean) ?? false,
      meetingRoom: (data.meetingRoom as string | null) ?? null,
      createdById: data.createdById as string,
      createdAt: now,
      updatedAt: now,
      seriesId: (data.seriesId as string | null) ?? null,
      detachedFromSeries: (data.detachedFromSeries as boolean) ?? false,
    };
  }

  const calendarEvent = {
    findUnique: async ({
      where,
      include,
    }: {
      where: { id: string };
      include?: { series?: boolean };
    }) => {
      const row = events.get(where.id);
      if (!row) return null;
      const clone: Record<string, unknown> = { ...row };
      if (include?.series) {
        clone.series = row.seriesId ? { ...series.get(row.seriesId)! } : null;
      }
      return clone;
    },
    findFirst: async ({
      where,
      orderBy,
    }: {
      where?: Record<string, unknown>;
      orderBy?: { startsAt?: "asc" | "desc" };
    }) => {
      let rows = [...events.values()].filter((r) => matchEvent(r, where));
      if (orderBy?.startsAt) {
        rows = rows.sort(
          (a, b) =>
            (a.startsAt.getTime() - b.startsAt.getTime()) *
            (orderBy.startsAt === "desc" ? -1 : 1),
        );
      }
      return rows[0] ? { ...rows[0] } : null;
    },
    findMany: async ({ where }: { where?: Record<string, unknown> }) =>
      [...events.values()].filter((r) => matchEvent(r, where)).map((r) => ({ ...r })),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = makeEventRow(data);
      events.set(row.id, row);
      return { ...row };
    },
    createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
      for (const d of data) {
        const row = makeEventRow(d);
        events.set(row.id, row);
      }
      return { count: data.length };
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const existing = events.get(where.id);
      if (!existing) throw new Error(`event ${where.id} not found`);
      const updated: EventRow = { ...existing, ...data, updatedAt: new Date() } as EventRow;
      events.set(where.id, updated);
      return { ...updated };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const existing = events.get(where.id);
      if (!existing) throw new Error(`event ${where.id} not found`);
      events.delete(where.id);
      return { ...existing };
    },
    deleteMany: async ({ where }: { where?: Record<string, unknown> }) => {
      let count = 0;
      for (const [id, row] of [...events.entries()]) {
        if (matchEvent(row, where)) {
          events.delete(id);
          count += 1;
        }
      }
      return { count };
    },
    count: async ({ where }: { where?: Record<string, unknown> }) =>
      [...events.values()].filter((r) => matchEvent(r, where)).length,
  };

  const calendarEventSeries = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const now = new Date();
      const row: SeriesRow = {
        id: (data.id as string) ?? nextId("series"),
        frequency: data.frequency as string,
        interval: (data.interval as number) ?? 1,
        until: (data.until as Date | null) ?? null,
        count: (data.count as number | null) ?? null,
        createdById: data.createdById as string,
        createdAt: now,
        updatedAt: now,
      };
      series.set(row.id, row);
      return { ...row };
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const existing = series.get(where.id);
      if (!existing) throw new Error(`series ${where.id} not found`);
      const updated = { ...existing, ...data, updatedAt: new Date() } as SeriesRow;
      series.set(where.id, updated);
      return { ...updated };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const existing = series.get(where.id);
      if (!existing) throw new Error(`series ${where.id} not found`);
      series.delete(where.id);
      return { ...existing };
    },
  };

  const prisma: Record<string, unknown> = {
    calendarEvent,
    calendarEventSeries,
    // Advisory-lock statement — a no-op against the in-memory store.
    $executeRaw: async () => 0,
  };
  prisma.$transaction = async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => Promise<unknown>)(prisma);
    }
    return Promise.all(arg as Promise<unknown>[]);
  };

  return { prisma, events, series, reset: () => { events.clear(); series.clear(); seq = 0; } };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));

import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  type ResolvedEventData,
} from "@/lib/calendar-service";

const WEEKLY_3: RecurrenceRule = {
  frequency: "WEEKLY",
  interval: 1,
  endMode: "count",
  count: 3,
};

function data(overrides: Partial<ResolvedEventData> = {}): ResolvedEventData {
  return {
    title: "Weekly standup",
    location: null,
    details: null,
    allDay: false,
    isMeeting: false,
    startsAt: new Date(2026, 7, 3, 18, 0), // Mon 3 Aug 2026, 6pm
    endsAt: new Date(2026, 7, 3, 19, 0),
    recurrence: null,
    ...overrides,
  };
}

/** Occurrences of a series, earliest first. */
function occurrencesOf(seriesId: string) {
  return [...h.events.values()]
    .filter((e) => e.seriesId === seriesId)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

beforeEach(() => h.reset());

describe("updateCalendarEvent — single vs series, exception survival", () => {
  it("returns null for an unknown id", async () => {
    expect(
      await updateCalendarEvent("nope", data(), "single", "member-1"),
    ).toBeNull();
  });

  it("edits a standalone event in place", async () => {
    const created = await createCalendarEvent(data(), "member-1");
    const res = await updateCalendarEvent(
      created.id,
      data({ title: "Renamed" }),
      "single",
      "member-1",
    );
    expect(res?.scope).toBe("single");
    expect(h.events.get(created.id)?.title).toBe("Renamed");
  });

  it("HEADLINE: a single-occurrence edit becomes an exception the later series edit leaves untouched", async () => {
    // Build a 3-occurrence weekly series.
    const anchor = await createCalendarEvent(
      data({ recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;
    const [occ1, occ2, occ3] = occurrencesOf(seriesId);
    expect([occ1, occ2, occ3].every(Boolean)).toBe(true);

    // 1) Edit ONLY the middle occurrence.
    const single = await updateCalendarEvent(
      occ2.id,
      data({ title: "Moved standup", recurrence: WEEKLY_3 }),
      "single",
      "member-1",
    );
    expect(single?.scope).toBe("single");
    const detached = h.events.get(occ2.id)!;
    expect(detached.title).toBe("Moved standup");
    expect(detached.detachedFromSeries).toBe(true);

    // 2) Edit the WHOLE series (same pattern → field propagation).
    const series = await updateCalendarEvent(
      anchor.id,
      data({ title: "Team sync", recurrence: WEEKLY_3 }),
      "series",
      "member-1",
    );
    expect(series?.scope).toBe("series");

    // The exception survives: the detached occurrence keeps its own title…
    expect(h.events.get(occ2.id)!.title).toBe("Moved standup");
    expect(h.events.get(occ2.id)!.detachedFromSeries).toBe(true);
    // …while every non-detached occurrence took the series-wide change.
    expect(h.events.get(occ1.id)!.title).toBe("Team sync");
    expect(h.events.get(occ3.id)!.title).toBe("Team sync");
  });

  it("regenerates the series when the pattern changes, preserving detached exceptions", async () => {
    const anchor = await createCalendarEvent(
      data({ recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;
    const [, occ2] = occurrencesOf(seriesId);

    // Detach the middle occurrence first.
    await updateCalendarEvent(
      occ2.id,
      data({ title: "Detached", recurrence: WEEKLY_3 }),
      "single",
      "member-1",
    );

    // Change the recurrence COUNT (pattern change → regenerate).
    const newRule: RecurrenceRule = { ...WEEKLY_3, count: 2 };
    await updateCalendarEvent(
      anchor.id,
      data({ recurrence: newRule }),
      "series",
      "member-1",
    );

    const rows = [...h.events.values()].filter((e) => e.seriesId === seriesId);
    const detached = rows.filter((e) => e.detachedFromSeries);
    const regenerated = rows.filter((e) => !e.detachedFromSeries);
    // The detached exception is untouched; the non-detached set was rebuilt to
    // the new count.
    expect(detached).toHaveLength(1);
    expect(detached[0].title).toBe("Detached");
    expect(regenerated).toHaveLength(2);
  });
});

describe("deleteCalendarEvent", () => {
  it("returns null for an unknown id", async () => {
    expect(await deleteCalendarEvent("nope", "single")).toBeNull();
  });

  it("deletes a whole series and its series row", async () => {
    const anchor = await createCalendarEvent(
      data({ recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;

    const res = await deleteCalendarEvent(anchor.id, "series");
    expect(res?.scope).toBe("series");
    expect(res?.deletedCount).toBe(3);
    expect([...h.events.values()].some((e) => e.seriesId === seriesId)).toBe(false);
    expect(h.series.has(seriesId)).toBe(false);
  });

  it("deletes a single occurrence and tidies the emptied series row", async () => {
    // A 1-occurrence series so deleting the occurrence empties it.
    const single: RecurrenceRule = { ...WEEKLY_3, count: 1 };
    const anchor = await createCalendarEvent(
      data({ recurrence: single }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;

    const res = await deleteCalendarEvent(anchor.id, "single");
    expect(res?.scope).toBe("single");
    expect(h.events.has(anchor.id)).toBe(false);
    // The now-empty series row is cleaned up.
    expect(h.series.has(seriesId)).toBe(false);
  });
});
