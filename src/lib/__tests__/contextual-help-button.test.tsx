// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextualHelpButton } from "@/components/contextual-help-button";

const mocks = vi.hoisted(() => ({
  pathname: "/admin/members",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

describe("ContextualHelpButton", () => {
  beforeEach(() => {
    mocks.pathname = "/admin/members";
  });

  it("opens route-specific admin help from the icon button", () => {
    render(<ContextualHelpButton scope="admin" />);

    fireEvent.click(screen.getByRole("button", { name: "Open Members help" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Members help")).toBeTruthy();
    expect(screen.getByText("Access role")).toBeTruthy();
  });

  it("uses parent help for nested admin routes", () => {
    mocks.pathname = "/admin/bookings/booking-1";

    render(<ContextualHelpButton scope="admin" />);

    fireEvent.click(screen.getByRole("button", { name: "Open Bookings help" }));

    expect(screen.getByText("Booking status")).toBeTruthy();
    expect(screen.getByText("Payment status")).toBeTruthy();
  });

  it("opens finance help in the finance shell", () => {
    mocks.pathname = "/finance";

    render(<ContextualHelpButton scope="finance" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Open Finance Dashboard help" }),
    );

    expect(screen.getByText("Finance Dashboard help")).toBeTruthy();
    expect(screen.getByText("Sync status")).toBeTruthy();
  });
});
