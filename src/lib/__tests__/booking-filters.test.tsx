// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
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

describe("BookingFilters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentSearch = "";
  });

  it("hides the bed-state filter and drops stale bed params when bed allocation is disabled", () => {
    mocks.currentSearch = "status=PAID&bedState=unallocated&search=Aroha";

    render(<BookingFilters showBedAllocation={false} />);

    expect(screen.queryByText("Beds")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));

    const url = pushedBookingsUrl();
    expect(url.pathname).toBe("/admin/bookings");
    expect(url.searchParams.get("status")).toBe("PAID");
    expect(url.searchParams.get("search")).toBe("Aroha");
    expect(url.searchParams.has("bedState")).toBe(false);
  });
});
