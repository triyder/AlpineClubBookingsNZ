// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_LOCALE } from "@/config/operational";

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

import { BookingCalendar } from "@/components/booking-calendar";

// A day in the current month that is never in the past: tomorrow, clamped to
// the month's last day (the last day equals "today" at month end, which the
// calendar still treats as bookable).
const now = new Date();
const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
const targetDay = Math.min(now.getDate() + 1, lastDay);
const targetIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;

describe("BookingCalendar accessibility", () => {
  beforeEach(() => {
    // 6 beds occupied on the target day -> 14 of 20 free.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          availability: { [targetIso]: 6 },
          seasons: {},
        }),
      })),
    );
  });

  it("labels day buttons with the date and available beds", async () => {
    render(<BookingCalendar onDateSelect={() => {}} />);

    const date = new Date(now.getFullYear(), now.getMonth(), targetDay);
    const dateLabel = date.toLocaleDateString(APP_LOCALE, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: `${dateLabel}, 14 of 20 beds free`,
        }),
      ).not.toBeNull(),
    );
  });

  it("announces the selection prompt via a live region", () => {
    const { container } = render(<BookingCalendar onDateSelect={() => {}} />);

    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("Select check-in date");
  });

  it("exposes the selected check-in to screen readers", async () => {
    const date = new Date(now.getFullYear(), now.getMonth(), targetDay);
    render(<BookingCalendar onDateSelect={() => {}} selectedCheckIn={date} />);

    const dateLabel = date.toLocaleDateString(APP_LOCALE, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    const selected = await waitFor(() =>
      screen.getByRole("button", {
        name: `${dateLabel}, 14 of 20 beds free, selected as check-in`,
      }),
    );
    expect(selected.getAttribute("aria-pressed")).toBe("true");
  });
});
