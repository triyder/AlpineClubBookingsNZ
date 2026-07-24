// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import { EventDialog } from "../event-dialog";

const oneOff: CalendarEventDTO = {
  id: "evt-1",
  title: "Committee meeting",
  location: null,
  details: null,
  allDay: false,
  startsAt: "2026-08-03T18:00:00.000Z",
  endsAt: "2026-08-03T19:00:00.000Z",
  isMeeting: false,
  meetingUrl: null,
  seriesId: null,
  detachedFromSeries: false,
  recurrence: null,
};

function renderEdit() {
  const onOpenChange = vi.fn();
  render(
    <EventDialog
      open
      onOpenChange={onOpenChange}
      event={oneOff}
      initialDate={null}
      canCreate
      canManage
      canEditExisting
      onSaved={vi.fn()}
    />,
  );
  return { onOpenChange };
}

afterEach(cleanup);

describe("EventDialog — in-app confirms (no native window.confirm)", () => {
  it("opens an in-app delete confirmation dialog instead of window.confirm", () => {
    // Guard: if the component ever regressed to window.confirm this spy would be
    // hit; it must NOT be.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderEdit();

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));

    expect(screen.getByText(/This cannot be undone/i)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe("EventDialog — unsaved-changes guard", () => {
  it("closes straight away when nothing was edited", () => {
    const { onOpenChange } = renderEdit();
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText(/Discard changes\?/i)).not.toBeInTheDocument();
  });

  it("prompts before discarding when the form is dirty, and can keep editing", () => {
    const { onOpenChange } = renderEdit();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Committee meeting (moved)" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    // The dialog does not close yet — it asks first.
    expect(screen.getByText(/Discard changes\?/i)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Keep editing/i }));
    expect(screen.queryByText(/Discard changes\?/i)).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("discards and closes when confirmed", () => {
    const { onOpenChange } = renderEdit();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Discard$/ }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
