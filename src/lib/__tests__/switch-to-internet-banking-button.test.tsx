// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { SwitchToInternetBankingButton } from "@/components/switch-to-internet-banking-button";

beforeEach(() => {
  refreshMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SwitchToInternetBankingButton", () => {
  it("posts the booking id and refreshes on success", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ reference: "BOOKING-ABCD1234" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SwitchToInternetBankingButton bookingId="abcd1234-booking" />);

    fireEvent.click(
      screen.getByRole("button", { name: /Pay by internet banking instead/ })
    );

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled();
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain("/api/payments/switch-to-internet-banking");
    expect(JSON.parse(init.body)).toEqual({ bookingId: "abcd1234-booking" });
  });

  it("surfaces the API error and does not refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: "Internet Banking payments are not available." }),
      }))
    );

    render(<SwitchToInternetBankingButton bookingId="abcd1234-booking" />);

    fireEvent.click(
      screen.getByRole("button", { name: /Pay by internet banking instead/ })
    );

    expect(
      await screen.findByText(/Internet Banking payments are not available./)
    ).toBeDefined();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
