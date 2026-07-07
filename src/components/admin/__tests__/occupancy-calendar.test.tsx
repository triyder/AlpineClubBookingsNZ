// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { OccupancyCalendar } from "@/components/admin/occupancy-calendar";

const occupancyResponse = {
  month: "2099-07",
  nights: [
    {
      date: "2099-07-10",
      guestCount: 1,
      bookings: [
        {
          id: "booking-1",
          reference: "BOOKING1",
          ownerName: "Alex Snow",
          checkIn: "2099-07-10",
          checkOut: "2099-07-12",
          guestCount: 1,
          status: "PAID",
        },
      ],
    },
    {
      date: "2099-07-11",
      guestCount: 2,
      bookings: [
        {
          id: "booking-1",
          reference: "BOOKING1",
          ownerName: "Alex Snow",
          checkIn: "2099-07-10",
          checkOut: "2099-07-12",
          guestCount: 2,
          status: "PAID",
        },
      ],
    },
  ],
  bookings: [
    {
      id: "booking-1",
      reference: "BOOKING1",
      ownerName: "Alex Snow",
      checkIn: "2099-07-10",
      checkOut: "2099-07-12",
      guestCount: 2,
      status: "PAID",
    },
  ],
};

const crossMonthResponses = {
  "2099-07": {
    month: "2099-07",
    nights: [
      {
        date: "2099-07-31",
        guestCount: 1,
        bookings: [
          {
            id: "booking-cross",
            reference: "CROSS1",
            ownerName: "Riley Frost",
            checkIn: "2099-07-31",
            checkOut: "2099-08-02",
            guestCount: 1,
            status: "PAID",
          },
        ],
      },
    ],
    bookings: [
      {
        id: "booking-cross",
        reference: "CROSS1",
        ownerName: "Riley Frost",
        checkIn: "2099-07-31",
        checkOut: "2099-08-02",
        guestCount: 2,
        status: "PAID",
      },
    ],
  },
  "2099-08": {
    month: "2099-08",
    nights: [
      {
        date: "2099-08-01",
        guestCount: 1,
        bookings: [
          {
            id: "booking-cross",
            reference: "CROSS1",
            ownerName: "Riley Frost",
            checkIn: "2099-07-31",
            checkOut: "2099-08-02",
            guestCount: 1,
            status: "PAID",
          },
        ],
      },
    ],
    bookings: [
      {
        id: "booking-cross",
        reference: "CROSS1",
        ownerName: "Riley Frost",
        checkIn: "2099-07-31",
        checkOut: "2099-08-02",
        guestCount: 2,
        status: "PAID",
      },
    ],
  },
};

function stubFetchByMonth(
  responses: Record<string, typeof occupancyResponse>,
) {
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    const response = responses[url.searchParams.get("month") ?? ""];
    return {
      ok: Boolean(response),
      json: async () => response,
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

function stubFetch() {
  return stubFetchByMonth({ [occupancyResponse.month]: occupancyResponse });
}

function stubFetchWithFirstJulyFailure() {
  let julyAttempts = 0;
  const emptyAugustResponse = {
    month: "2099-08",
    nights: [],
    bookings: [],
  };
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    const month = url.searchParams.get("month");
    if (month === "2099-07") {
      julyAttempts += 1;
      if (julyAttempts === 1) {
        return {
          ok: false,
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        json: async () => occupancyResponse,
      };
    }
    return {
      ok: month === "2099-08",
      json: async () => emptyAugustResponse,
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

function stubFetchWithAugustFailure() {
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    const month = url.searchParams.get("month");
    if (month === "2099-07") {
      return {
        ok: true,
        json: async () => occupancyResponse,
      };
    }
    return {
      ok: false,
      json: async () => ({}),
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

function RangeHarness() {
  const [selection, setSelection] = useState({ startDate: "2099-07-01", endDate: "" });
  return (
    <>
      <output data-testid="range-output">
        {selection.startDate}|{selection.endDate}
      </output>
      <OccupancyCalendar
        mode="range"
        selectedStartDate={selection.startDate}
        selectedEndDate={selection.endDate}
        onSelectionChange={setSelection}
      />
    </>
  );
}

function SingleHarness() {
  const [selectedDate, setSelectedDate] = useState("2099-07-01");
  return (
    <>
      <output data-testid="single-output">{selectedDate}</output>
      <OccupancyCalendar
        mode="single"
        selectedStartDate={selectedDate}
        selectedEndDate={selectedDate}
        onSelectionChange={({ startDate }) => setSelectedDate(startDate)}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OccupancyCalendar", () => {
  it("selects a range and shows bookings for the selected nights", async () => {
    const fetchMock = stubFetch();
    render(<RangeHarness />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/occupancy?month=2099-07"),
    );

    fireEvent.click(screen.getByRole("button", { name: /10 Jul.*1 guest/i }));
    expect(screen.getByTestId("range-output")).toHaveTextContent("2099-07-10|");

    fireEvent.click(screen.getByRole("button", { name: /11 Jul.*2 guests/i }));
    expect(screen.getByTestId("range-output")).toHaveTextContent("2099-07-10|2099-07-11");

    expect(screen.getByText("Alex Snow")).toBeInTheDocument();
    expect(screen.getAllByText(/3 guest-nights/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/2099-07-10 to 2099-07-12 - 3 guest-nights/i),
    ).toBeInTheDocument();
  });

  it("loads every month needed for a cross-month selected range", async () => {
    const fetchMock = stubFetchByMonth(crossMonthResponses);
    render(<RangeHarness />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/occupancy?month=2099-07"),
    );

    fireEvent.click(screen.getByRole("button", { name: /31 Jul.*1 guest/i }));
    expect(screen.getByTestId("range-output")).toHaveTextContent("2099-07-31|");

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/occupancy?month=2099-08"),
    );
    fireEvent.click(await screen.findByRole("button", { name: /1 Aug.*1 guest/i }));

    expect(screen.getByTestId("range-output")).toHaveTextContent(
      "2099-07-31|2099-08-01",
    );
    expect(screen.getByText("Riley Frost")).toBeInTheDocument();
    expect(screen.getAllByText(/2 guest-nights/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/2099-07-31 to 2099-08-02 - 2 guest-nights/i),
    ).toBeInTheDocument();
  });

  it("shows a failed selection state and retries a failed month later", async () => {
    const fetchMock = stubFetchWithFirstJulyFailure();
    render(<RangeHarness />);

    await screen.findByText("Occupancy could not be loaded.");
    expect(
      screen.getByText("Occupancy could not be loaded for this selection."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Loading occupancy for this selection..."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/occupancy?month=2099-08"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => input === "/api/admin/occupancy?month=2099-07",
        ),
      ).toHaveLength(2);
    });

    expect(await screen.findByRole("button", { name: /10 Jul.*1 guest/i }))
      .toBeInTheDocument();
  });

  it("clears a stale error banner when returning to a cached loaded month", async () => {
    stubFetchWithAugustFailure();
    render(<RangeHarness />);

    expect(await screen.findByRole("button", { name: /10 Jul.*1 guest/i }))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    await screen.findByText("Occupancy could not be loaded.");

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() =>
      expect(screen.queryByText("Occupancy could not be loaded.")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /10 Jul.*1 guest/i }))
      .toBeInTheDocument();
  });

  it("selects one date in single mode", async () => {
    stubFetch();
    render(<SingleHarness />);

    await screen.findByRole("button", { name: /11 Jul.*2 guests/i });
    fireEvent.click(screen.getByRole("button", { name: /11 Jul.*2 guests/i }));

    expect(screen.getByTestId("single-output")).toHaveTextContent("2099-07-11");
    expect(screen.getByText(/2099-07-11 to 2099-07-11/i)).toBeInTheDocument();
    expect(screen.getByText("Alex Snow")).toBeInTheDocument();
  });
});
