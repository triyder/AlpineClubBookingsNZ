// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingFilters } from "@/components/admin/booking-filters";
import { addDaysDateOnly, formatDateOnly, getTodayDateOnly } from "@/lib/date-only";

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

  it("seeds legacy from/to into checkInFrom/checkOutTo, matching the server semantics (#1720)", async () => {
    // Server-side, legacy `from` bounds check-IN and legacy `to` bounds
    // check-OUT (admin-bookings-service). Seeding must match, so the URL
    // rewrite keeps the legacy link's result set.
    const legacyFrom = formatDateOnly(getTodayDateOnly());
    const legacyTo = formatDateOnly(addDaysDateOnly(getTodayDateOnly(), 14));
    mocks.currentSearch = `from=${legacyFrom}&to=${legacyTo}`;
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    expect((screen.getByLabelText("Check In From") as HTMLInputElement).value).toBe(legacyFrom);
    expect((screen.getByLabelText("Check In To") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Check Out To") as HTMLInputElement).value).toBe(legacyTo);

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const url = pushedBookingsUrl();
    expect(url.searchParams.get("checkInFrom")).toBe(legacyFrom);
    expect(url.searchParams.get("checkOutTo")).toBe(legacyTo);
    expect(url.searchParams.has("checkInTo")).toBe(false);
    expect(url.searchParams.has("from")).toBe(false);
    expect(url.searchParams.has("to")).toBe(false);
  });

  it("ignores legacy to when an explicit checkInTo is present, matching the server precedence", async () => {
    // admin-bookings-service drops legacy `to` whenever an explicit
    // checkInTo/checkOutTo param exists, so seeding it here would add a
    // check-out bound the server never applied.
    const checkInTo = formatDateOnly(getTodayDateOnly());
    const legacyTo = formatDateOnly(addDaysDateOnly(getTodayDateOnly(), 30));
    mocks.currentSearch = `checkInTo=${checkInTo}&to=${legacyTo}`;
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    expect((screen.getByLabelText("Check In To") as HTMLInputElement).value).toBe(checkInTo);
    expect((screen.getByLabelText("Check Out To") as HTMLInputElement).value).toBe("");

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const url = pushedBookingsUrl();
    expect(url.searchParams.get("checkInTo")).toBe(checkInTo);
    expect(url.searchParams.has("checkOutTo")).toBe(false);
    expect(url.searchParams.has("to")).toBe(false);
  });

  it("keeps an explicit checkOutTo over legacy to", async () => {
    const checkOutTo = formatDateOnly(getTodayDateOnly());
    const legacyTo = formatDateOnly(addDaysDateOnly(getTodayDateOnly(), 30));
    mocks.currentSearch = `checkOutTo=${checkOutTo}&to=${legacyTo}`;
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    expect((screen.getByLabelText("Check Out To") as HTMLInputElement).value).toBe(checkOutTo);

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const url = pushedBookingsUrl();
    expect(url.searchParams.get("checkOutTo")).toBe(checkOutTo);
    expect(url.searchParams.has("to")).toBe(false);
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
