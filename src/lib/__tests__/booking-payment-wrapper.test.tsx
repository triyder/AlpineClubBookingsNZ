// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";
import BookingPaymentWrapper from "@/components/stripe/BookingPaymentWrapper";

const fetchMock = vi.fn();

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/components/stripe/StripeProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-provider">{children}</div>
  ),
}));

vi.mock("@/components/stripe/PaymentForm", () => ({
  default: ({
    onError,
    onSuccess,
    chargedAmountCents,
    isSplit,
    deferredGuestAmountCents,
  }: {
    onError: (error: string) => void;
    onSuccess: (paymentIntentId: string) => void;
    chargedAmountCents?: number | null;
    isSplit?: boolean | null;
    deferredGuestAmountCents?: number | null;
  }) => (
    <div>
      <div>payment-form</div>
      <div data-testid="charged-amount">{String(chargedAmountCents)}</div>
      <div data-testid="is-split">{String(isSplit)}</div>
      <div data-testid="deferred-amount">
        {String(deferredGuestAmountCents)}
      </div>
      <button type="button" onClick={() => onError("Card declined")}>
        trigger-error
      </button>
      <button type="button" onClick={() => onSuccess("pi_success")}>
        trigger-success
      </button>
    </div>
  ),
}));

vi.mock("@/components/stripe/SetupForm", () => ({
  default: () => <div>setup-form</div>,
}));

describe("BookingPaymentWrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
  });

  it("keeps the payment form mounted after a recoverable payment error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ clientSecret: "cs_test" }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.queryByText("payment-form")).not.toBeNull());

    fireEvent.click(screen.getByText("trigger-error"));

    expect(screen.queryByText("payment-form")).not.toBeNull();
    expect(screen.queryByText("Payment Error")).toBeNull();
  });

  it("shows generic copy and never renders the raw provider error when init fails", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const rawProviderError = "Invalid API Key provided: sk_test_51SecretKeyMaterial";
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: rawProviderError }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.queryByText("Payment Error")).not.toBeNull());

    // Generic, member-safe copy is shown (the pay-later recovery affordance).
    expect(
      screen.queryByText(/you can\s+pay later from your booking page/i)
    ).not.toBeNull();

    // The raw provider detail (and any partial key material) must NOT reach the DOM.
    expect(document.body.textContent).not.toContain("sk_test");
    expect(document.body.textContent).not.toContain("Invalid API Key");
    expect(screen.queryByText(/Invalid API Key/i)).toBeNull();

    // The detail is reported to Sentry (scrubbed by beforeSend), NOT to the
    // member's browser console — the client console log carries bookingId only,
    // so no raw provider/key material lands in a member's DevTools (#1223).
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Booking payment initialization failed",
      { bookingId: "booking-1" }
    );
    const consoleArgs = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(consoleArgs).not.toContain("sk_test");
    expect(consoleArgs).not.toContain("Invalid API Key");

    consoleErrorSpy.mockRestore();
  });

  it("forwards the server charge figures to PaymentForm for a split parent (#1976)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        clientSecret: "cs_test",
        chargedAmountCents: 12000,
        isSplit: true,
        deferredGuestAmountCents: 8000,
      }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={20000}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.queryByText("payment-form")).not.toBeNull());
    expect(screen.getByTestId("charged-amount").textContent).toBe("12000");
    expect(screen.getByTestId("is-split").textContent).toBe("true");
    expect(screen.getByTestId("deferred-amount").textContent).toBe("8000");
  });

  it("passes null deferred amount to PaymentForm for a non-split booking (#1976)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        clientSecret: "cs_test",
        chargedAmountCents: 12500,
        isSplit: false,
        deferredGuestAmountCents: null,
      }),
    });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.queryByText("payment-form")).not.toBeNull());
    expect(screen.getByTestId("charged-amount").textContent).toBe("12500");
    expect(screen.getByTestId("is-split").textContent).toBe("false");
    expect(screen.getByTestId("deferred-amount").textContent).toBe("null");
  });

  it("reconciles a successful payment before refreshing the page", async () => {
    const onPaymentComplete = vi.fn();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ clientSecret: "cs_test" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

    render(
      <BookingPaymentWrapper
        bookingId="booking-1"
        amountCents={12500}
        paymentMode="payment"
        returnUrl="http://localhost/bookings/booking-1"
        onPaymentComplete={onPaymentComplete}
      />
    );

    await waitFor(() => expect(screen.queryByText("payment-form")).not.toBeNull());

    fireEvent.click(screen.getByText("trigger-success"));

    await waitFor(() => expect(onPaymentComplete).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/bookings/booking-1/confirm-payment",
      expect.objectContaining({
        method: "POST",
      })
    );
  });
});
