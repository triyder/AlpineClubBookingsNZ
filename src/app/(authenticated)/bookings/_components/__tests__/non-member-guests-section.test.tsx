// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BookingStatus } from "@prisma/client";
import {
  NonMemberGuestsSection,
  type NonMemberGuestChild,
} from "@/app/(authenticated)/bookings/_components/non-member-guests-section";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function child(overrides: Partial<NonMemberGuestChild> = {}): NonMemberGuestChild {
  return {
    id: "child-1",
    status: "PENDING" as BookingStatus,
    guestCount: 2,
    finalPriceCents: 9000,
    datesDiffer: false,
    checkIn: new Date("2026-08-10T00:00:00.000Z"),
    checkOut: new Date("2026-08-12T00:00:00.000Z"),
    ...overrides,
  };
}

describe("NonMemberGuestsSection (#1975 parent detail section)", () => {
  it("renders nothing when there are no children", () => {
    const { container } = render(
      <NonMemberGuestsSection guests={[]} nonOwnerAdminViewer={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the owner heading and a link to each child booking", () => {
    render(
      <NonMemberGuestsSection
        guests={[child()]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(
      screen.getByText("Your non-member guests"),
    ).toBeInTheDocument();
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/bookings/child-1");
    expect(link).toHaveTextContent("2 non-member guests");
    expect(link).toHaveTextContent("$90.00");
  });

  it("uses third-person copy for a non-owner admin viewer", () => {
    render(
      <NonMemberGuestsSection guests={[child()]} nonOwnerAdminViewer />,
    );
    expect(
      screen.getByText("The member's non-member guests"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Your non-member guests"),
    ).not.toBeInTheDocument();
  });

  it("renders the child's own status badge (e.g. a PENDING child under a PAID parent)", () => {
    render(
      <NonMemberGuestsSection
        guests={[child({ status: "PENDING" as BookingStatus })]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("shows a cancelled child's status", () => {
    render(
      <NonMemberGuestsSection
        guests={[child({ status: "CANCELLED" as BookingStatus })]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("hides dates when they match the parent and shows them when they differ", () => {
    const { rerender } = render(
      <NonMemberGuestsSection
        guests={[child({ datesDiffer: false })]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(screen.queryByText(/August 2026/)).not.toBeInTheDocument();

    rerender(
      <NonMemberGuestsSection
        guests={[child({ datesDiffer: true })]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(screen.getByText(/August 2026/)).toBeInTheDocument();
  });

  it("lists multiple children each with its own link and status", () => {
    render(
      <NonMemberGuestsSection
        guests={[
          child({ id: "child-1", status: "PENDING" as BookingStatus }),
          child({ id: "child-2", status: "BUMPED" as BookingStatus }),
        ]}
        nonOwnerAdminViewer={false}
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/bookings/child-1");
    expect(links[1]).toHaveAttribute("href", "/bookings/child-2");
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Bumped")).toBeInTheDocument();
  });

  it("uses the singular noun for a single guest", () => {
    render(
      <NonMemberGuestsSection
        guests={[child({ guestCount: 1 })]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(screen.getByRole("link")).toHaveTextContent("1 non-member guest");
    expect(screen.getByRole("link")).not.toHaveTextContent("guests");
  });
});
