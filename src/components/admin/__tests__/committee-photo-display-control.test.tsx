// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  canEdit: vi.fn<() => boolean | undefined>(() => true),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => mocks.canEdit(),
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { CommitteePhotoDisplayControl } from "@/components/admin/committee-photo-display-control";

const FULL_SETTINGS = {
  membershipTypes: true,
  entranceFees: false,
  hutFees: true,
  bookingPolicySummary: false,
  cancellationPolicy: true,
  annualFees: false,
  showBookNow: true,
  bookNowTarget: "BOOKING_FLOW",
  bookNowPageId: null,
  committeePhotoDisplay: "NONE",
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canEdit.mockReturnValue(true);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommitteePhotoDisplayControl", () => {
  it("loads the setting and saves the FULL settings with only the display changed", async () => {
    fetchMock.mockImplementation(async (_url, init?: RequestInit) => {
      if (!init) {
        return new Response(JSON.stringify({ settings: FULL_SETTINGS }));
      }
      return new Response(JSON.stringify({ settings: FULL_SETTINGS }));
    });

    render(<CommitteePhotoDisplayControl />);

    const select = (await screen.findByLabelText(
      "Committee photo display",
    )) as HTMLSelectElement;
    expect(select.value).toBe("NONE");
    expect(select.disabled).toBe(false);

    fireEvent.change(select, { target: { value: "CIRCLE" } });
    fireEvent.click(screen.getByRole("button", { name: /save photo display/i }));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
      expect(putCall).toBeTruthy();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      // Only the display changed; every other setting is preserved.
      expect(body).toEqual({ ...FULL_SETTINGS, committeePhotoDisplay: "CIRCLE" });
    });
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
  });

  it("re-fetches before save and preserves a concurrent edit to another field (no lost update)", async () => {
    let getCount = 0;
    fetchMock.mockImplementation(async (_url, init?: RequestInit) => {
      if (!init) {
        getCount += 1;
        // Mount GET returns the original; the pre-save GET reflects another admin
        // having toggled showBookNow off in the meantime.
        const settings =
          getCount === 1
            ? FULL_SETTINGS
            : { ...FULL_SETTINGS, showBookNow: false };
        return new Response(JSON.stringify({ settings }));
      }
      return new Response(JSON.stringify({ settings: FULL_SETTINGS }));
    });

    render(<CommitteePhotoDisplayControl />);

    const select = (await screen.findByLabelText(
      "Committee photo display",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "SQUARE" } });
    fireEvent.click(screen.getByRole("button", { name: /save photo display/i }));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
      expect(putCall).toBeTruthy();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      // The concurrent showBookNow:false is preserved; only the display changed.
      expect(body.showBookNow).toBe(false);
      expect(body.committeePhotoDisplay).toBe("SQUARE");
    });
  });

  it("is read-only for a content-view admin (disabled + explanation, no save)", async () => {
    mocks.canEdit.mockReturnValue(false);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ settings: FULL_SETTINGS })),
    );

    render(<CommitteePhotoDisplayControl />);

    const select = (await screen.findByLabelText(
      "Committee photo display",
    )) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(screen.getByText(/content edit access is required/i)).toBeTruthy();
    // No PUT is possible.
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "PUT")).toBe(false);
  });
});
