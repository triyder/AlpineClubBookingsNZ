// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import { EventDialog } from "../event-dialog";

// A stored MiroTalk meeting event, viewed on the member calendar (read-only:
// canEditExisting=false). The "Join meeting" button here must be gated on
// canManage so only committee members / admins can join — see
// src/lib/calendar-access.ts and the (authenticated)/calendar page.
const meetingEvent: CalendarEventDTO = {
  id: "evt-1",
  title: "Committee meeting",
  location: "Online",
  details: "Monthly sync",
  allDay: false,
  startsAt: "2026-08-01T19:00:00.000Z",
  endsAt: "2026-08-01T20:00:00.000Z",
  isMeeting: true,
  meetingUrl: "https://meet.example.com/room/abc",
  seriesId: null,
  detachedFromSeries: false,
  recurrence: null,
};

function renderReadOnly(canManage: boolean) {
  return render(
    <EventDialog
      open
      onOpenChange={vi.fn()}
      event={meetingEvent}
      initialDate={null}
      canCreate={canManage}
      canManage={canManage}
      canEditExisting={false}
      onSaved={vi.fn()}
    />,
  );
}

describe("EventDialog read-only Join meeting gating", () => {
  afterEach(cleanup);

  it("shows Join meeting to a committee member / admin (canManage=true)", () => {
    renderReadOnly(true);
    expect(
      screen.getByRole("link", { name: /Join meeting/i }),
    ).toHaveAttribute("href", meetingEvent.meetingUrl);
  });

  it("hides Join meeting from an ordinary member (canManage=false)", () => {
    renderReadOnly(false);
    // The event details still render for everyone…
    expect(screen.getByText("Committee meeting")).toBeInTheDocument();
    // …but the meeting link is not offered.
    expect(
      screen.queryByRole("link", { name: /Join meeting/i }),
    ).not.toBeInTheDocument();
  });
});
