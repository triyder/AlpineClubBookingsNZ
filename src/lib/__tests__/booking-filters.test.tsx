// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingFilters } from "@/components/admin/booking-filters";

const mocks = vi.hoisted(() => ({
  currentSearch: "",
  routerPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.routerPush,
  }),
  useSearchParams: () => new URLSearchParams(mocks.currentSearch),
}));

function pushedBookingsUrl() {
  const pushedPath = mocks.routerPush.mock.calls.at(-1)?.[0] as string;
  return new URL(pushedPath, "http://localhost");
}

function setLocation(search: string) {
  window.history.replaceState(
    {},
    "",
    search ? `/admin/bookings?${search}` : "/admin/bookings",
  );
}

describe("BookingFilters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentSearch = "";
    setLocation("");
  });

  it("hides the bed-state filter and drops stale bed params when bed allocation is disabled", async () => {
    mocks.currentSearch = "status=PAID&bedState=unallocated&search=Aroha";
    setLocation(mocks.currentSearch);

    render(<BookingFilters showBedAllocation={false} />);

    expect(screen.queryByText("Beds")).toBeNull();

    // Filters apply automatically (debounced); the stale bedState param is
    // dropped without any Filter button click.
    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());

    const url = pushedBookingsUrl();
    expect(url.pathname).toBe("/admin/bookings");
    expect(url.searchParams.get("status")).toBe("PAID");
    expect(url.searchParams.get("search")).toBe("Aroha");
    expect(url.searchParams.has("bedState")).toBe(false);
  });

  it("does not navigate when the URL already matches the filters", async () => {
    mocks.currentSearch = "status=PAID";
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    // Give the debounce a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("preserves the dashboard upcoming check-ins deep link", async () => {
    mocks.currentSearch = "upcoming=7";
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    // Regression guard for the debounced auto-apply effect: the dashboard link
    // must keep upcoming=7 instead of pushing /admin/bookings after load.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("renders comma-separated dashboard status deep links as the active state", async () => {
    mocks.currentSearch = "status=PAYMENT_PENDING,CONFIRMED,PAID,PENDING";
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    expect(
      screen.getByText("Payment Pending + Confirmed (Unpaid) + Paid + Pending"),
    ).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("navigates when the search input changes", async () => {
    mocks.currentSearch = "";
    setLocation("");

    render(<BookingFilters />);

    fireEvent.change(screen.getByPlaceholderText("Name or email..."), {
      target: { value: "Aroha" },
    });

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const url = pushedBookingsUrl();
    expect(url.searchParams.get("search")).toBe("Aroha");
  });
});
