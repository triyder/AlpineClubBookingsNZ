import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fork #118: when a work party's calendar entries are written, and from what.
 * The row writer (`replaceWorkPartyCalendarEvents`) is mocked; its own test is
 * `work-party-calendar-service.test.ts`.
 */
const h = vi.hoisted(() => ({
  replace: vi.fn(async () => 3),
  modules: { eventsCalendar: true },
  findFirst: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/calendar-work-party-entries", () => ({
  replaceWorkPartyCalendarEvents: h.replace,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => h.modules),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { calendarEvent: { findFirst: h.findFirst } },
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn() } }));

import {
  removeWorkPartyCalendar,
  syncCreatedWorkPartyCalendar,
  syncUpdatedWorkPartyCalendar,
  WORK_PARTY_CALENDAR_SYNC_FAILED,
  workPartyCalendarDays,
  workPartyCalendarEntry,
} from "@/lib/work-party-calendar";

const workParty = {
  id: "wp-1",
  name: "Spring Working Bee",
  description: "Bring gloves",
  // Date-only columns: UTC midnight encodings of the first and LAST night.
  startDate: new Date("2026-10-30T00:00:00.000Z"),
  endDate: new Date("2026-11-02T00:00:00.000Z"),
  lodge: { name: "Main Lodge" },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.modules.eventsCalendar = true;
  h.findFirst.mockResolvedValue(null);
});

describe("workPartyCalendarDays", () => {
  it("lists every night of the inclusive window, across a month boundary", () => {
    expect(workPartyCalendarDays(workParty)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("is one day for a one-night work party", () => {
    expect(
      workPartyCalendarDays({
        startDate: workParty.startDate,
        endDate: workParty.startDate,
      }),
    ).toEqual(["2026-10-30"]);
  });
});

describe("workPartyCalendarEntry", () => {
  it("titles the entry, uses the lodge as location and the description as details", () => {
    expect(workPartyCalendarEntry(workParty)).toMatchObject({
      title: "Work party: Spring Working Bee",
      location: "Main Lodge",
      details: "Bring gloves",
    });
  });

  it("has no location for a club-wide work party", () => {
    expect(workPartyCalendarEntry({ ...workParty, lodge: null }).location).toBeNull();
  });
});

describe("syncCreatedWorkPartyCalendar", () => {
  it("adds the entries when the Events Calendar is on", async () => {
    await expect(syncCreatedWorkPartyCalendar(workParty, "admin-1")).resolves.toBeNull();
    expect(h.replace).toHaveBeenCalledWith(
      "wp-1",
      expect.objectContaining({ title: "Work party: Spring Working Bee" }),
      "admin-1",
    );
  });

  it("adds nothing when the Events Calendar is off", async () => {
    h.modules.eventsCalendar = false;
    await expect(syncCreatedWorkPartyCalendar(workParty, "admin-1")).resolves.toBeNull();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("reports a calendar failure instead of throwing", async () => {
    h.replace.mockRejectedValueOnce(new Error("db down"));
    await expect(syncCreatedWorkPartyCalendar(workParty, "admin-1")).resolves.toBe(
      WORK_PARTY_CALENDAR_SYNC_FAILED,
    );
  });
});

describe("syncUpdatedWorkPartyCalendar", () => {
  it("regenerates the entries of a work party already on the calendar", async () => {
    h.findFirst.mockResolvedValue({ id: "evt-1" });
    await syncUpdatedWorkPartyCalendar(workParty, "admin-1");
    expect(h.findFirst).toHaveBeenCalledWith({
      where: { workPartyEventId: "wp-1" },
      select: { id: true },
    });
    expect(h.replace).toHaveBeenCalledTimes(1);
  });

  it("keeps linked entries in step even while the calendar module is off", async () => {
    h.modules.eventsCalendar = false;
    h.findFirst.mockResolvedValue({ id: "evt-1" });
    await syncUpdatedWorkPartyCalendar(workParty, "admin-1");
    expect(h.replace).toHaveBeenCalledTimes(1);
  });

  it("leaves a work party with no entries off the calendar (no duplicate of a hand-typed one)", async () => {
    await syncUpdatedWorkPartyCalendar(workParty, "admin-1");
    expect(h.replace).not.toHaveBeenCalled();
  });
});

describe("removeWorkPartyCalendar", () => {
  it("replaces the entries with nothing", async () => {
    await removeWorkPartyCalendar("wp-1", "admin-1");
    expect(h.replace).toHaveBeenCalledWith("wp-1", null, "admin-1");
  });
});
