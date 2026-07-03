// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminBookingCalendar } from "@/components/admin-booking-calendar";

// The component reads router/search params from next/navigation; provide
// minimal stand-ins so it renders outside the App Router.
const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(),
}));

// The calendar initially shows the current month, so build booking dates
// inside it (days 5-12 exist in every month).
const now = new Date();
const isoDay = (day: number) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const calendarResponse = {
  bookings: [
    {
      id: "booking-paid",
      memberName: "Paula Paid",
      checkIn: isoDay(5),
      checkOut: isoDay(7),
      status: "PAID",
      guestCount: 2,
    },
    {
      id: "booking-cancelled",
      memberName: "Casey Cancelled",
      checkIn: isoDay(10),
      checkOut: isoDay(12),
      status: "CANCELLED",
      guestCount: 1,
    },
  ],
  availability: {},
};

describe("AdminBookingCalendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => calendarResponse,
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("hides cancelled bookings by default with the Cancelled pill off", async () => {
    render(<AdminBookingCalendar />);

    // Non-cancelled bookings render once the fetch resolves.
    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });

    // The CANCELLED toggle pill starts in the off state; others stay on.
    expect(
      screen.getByRole("button", { name: "Cancelled" }).getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: "Paid" }).getAttribute("aria-pressed")
    ).toBe("true");

    // The cancelled booking bar is not rendered.
    expect(screen.queryByText(/Casey Cancelled/)).toBeNull();
  });

  it("shows cancelled bookings after the Cancelled pill is toggled on", async () => {
    render(<AdminBookingCalendar />);

    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancelled" }));

    expect(
      screen.getByRole("button", { name: "Cancelled" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByText(/Casey Cancelled/)).toBeTruthy();
  });

  it("persists the status toggles across visits (#1039)", async () => {
    const { unmount } = render(<AdminBookingCalendar />);

    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancelled" }));
    unmount();

    // A fresh mount (new visit) restores the stored choice instead of the
    // hide-cancelled default.
    render(<AdminBookingCalendar />);
    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Cancelled" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByText(/Casey Cancelled/)).toBeTruthy();
  });

  it("falls back to the hide-cancelled default when storage holds garbage (#1039)", async () => {
    window.localStorage.setItem(
      "admin-calendar-enabled-statuses",
      "not json at all",
    );

    render(<AdminBookingCalendar />);
    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Cancelled" }).getAttribute("aria-pressed")
    ).toBe("false");
    expect(screen.queryByText(/Casey Cancelled/)).toBeNull();
  });
});
