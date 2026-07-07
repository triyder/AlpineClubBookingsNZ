// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The component does a hard window.location.reload() on success (deterministic
// server re-render, #1148 / #1371) rather than a soft router.refresh(), so the
// test stubs location.reload instead of the router.
const reloadMock = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  reloadMock.mockReset();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload: reloadMock },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  vi.unstubAllGlobals();
});

import { SwitchToInternetBankingButton } from "@/components/switch-to-internet-banking-button";

describe("SwitchToInternetBankingButton", () => {
  it("posts the booking id and reloads on success", async () => {
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
      expect(reloadMock).toHaveBeenCalled();
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain("/api/payments/switch-to-internet-banking");
    expect(JSON.parse(init.body)).toEqual({ bookingId: "abcd1234-booking" });
  });

  it("surfaces the API error and does not reload", async () => {
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
    expect(reloadMock).not.toHaveBeenCalled();
  });
});
