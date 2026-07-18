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
// #1997: the button derives view-only gating from the session matrix via
// useAdminAreaEditAccess("bookings"). Mock an all-edit admin so the existing
// confirm-flow assertions (enabled action) hold.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
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
  it("does not POST until the confirmation dialog is accepted, then asks the email choice and POSTs it (#1769b)", async () => {
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

    // Consequence dialog is open; nothing has been POSTed yet.
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/saved card will be charged \$100\.00/i)
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Charge and confirm" }));

    // A charged-card booking sends a confirmation email, so the email-choice
    // dialog opens next — still no POST until the admin picks.
    const emailButton = await screen.findByRole("button", {
      name: "Confirm and email member",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(emailButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/bookings/b1/confirm-pending-guests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ notifyMember: true }),
      })
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });

  it("POSTs notifyMember:false and reflects the choice in the toast when the admin declines the email (#1769b)", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Charge and confirm" }));

    const noEmailButton = await screen.findByRole("button", {
      name: "Confirm without emailing",
    });
    fireEvent.click(noEmailButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/bookings/b1/confirm-pending-guests",
      expect.objectContaining({
        body: JSON.stringify({ notifyMember: false }),
      })
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Pending guests confirmed. The member was not emailed."
      )
    );
  });

  it("POSTs directly with no email-choice dialog on the payment-owed branch (#1769b)", async () => {
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
    // No card + priced → moves to payment-owed, emails no one → plain Confirm.
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // No email-choice dialog was shown, and the POST carries no notify field.
    expect(
      screen.queryByRole("button", { name: "Confirm and email member" })
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/bookings/b1/confirm-pending-guests",
      expect.objectContaining({ body: JSON.stringify({}) })
    );
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

    const emailButton = await screen.findByRole("button", {
      name: "Confirm and email member",
    });
    fireEvent.click(emailButton);

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
