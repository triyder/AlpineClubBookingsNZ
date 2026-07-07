// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  refresh: vi.fn(),
}));
const { toastSuccess, toastError, refresh } = mocks;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { ConfirmPendingGuestsButton } from "@/components/admin/confirm-pending-guests-button";

function stubFetch(response: { ok: boolean; body?: unknown }) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok,
    json: async () => response.body ?? {},
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ConfirmPendingGuestsButton", () => {
  it("does not POST until the confirmation dialog is accepted, and states the charge amount", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod
        finalPriceCents={10000}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" })
    );

    // Dialog is open; nothing has been POSTed yet.
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/saved card will be charged \$100\.00/i)
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Charge and confirm" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/bookings/b1/confirm-pending-guests",
      expect.objectContaining({ method: "POST" })
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });

  it("does not POST when the dialog is cancelled", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod={false}
        finalPriceCents={10000}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" })
    );
    // No-card copy is stated in the dialog.
    expect(
      screen.getByText(/payment-owed \(no card on file\)/i)
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.queryByText(/payment-owed \(no card on file\)/i)
      ).toBeNull()
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows an error toast (mapping CAPACITY_EXCEEDED) when the POST fails", async () => {
    stubFetch({ ok: false, body: { error: "CAPACITY_EXCEEDED" } });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod
        finalPriceCents={10000}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Charge and confirm" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Not enough beds remain for these dates. Use Force confirm to overbook if intended."
      )
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("states the no-charge copy and a plain Confirm label for a $0 booking", () => {
    stubFetch({ ok: true, body: { success: true } });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod
        finalPriceCents={0}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" })
    );

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/confirm the booking at no charge/i)
    ).not.toBeNull();
    // Zero-dollar path never charges, so the confirm affordance is a plain
    // "Confirm" — not "Charge and confirm".
    expect(
      within(dialog).queryByRole("button", { name: "Charge and confirm" })
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Confirm" })
    ).not.toBeNull();
  });
});
