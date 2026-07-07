// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BookingHelpDialog } from "@/components/booking-help-dialog";

describe("BookingHelpDialog", () => {
  it("points members to their profile family group when booking family is missing", () => {
    render(<BookingHelpDialog />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Booking status and cancellation help",
      }),
    );

    expect(screen.getByText("Family members on bookings")).toBeTruthy();
    expect(screen.getByText(/Family member missing/i)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open Family Group in your profile" })
        .getAttribute("href"),
    ).toBe("/profile?returnTo=%2Fbook#family-group");
  });
});
