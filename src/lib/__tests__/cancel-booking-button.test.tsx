// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { CancelBookingButton } from "@/components/cancel-booking-button";

const previewBody = {
  refundAmountCents: 4500,
  keptAmountCents: 500,
  changeFeeCents: 0,
  refundPercentage: 90,
  creditRefundAmountCents: 5000,
  creditRefundPercentage: 100,
  creditRestoredCents: 0,
  totalPaidCents: 5000,
  hasPayment: true,
};

function stubPreviewFetch(body: Record<string, unknown> = previewBody) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CancelBookingButton — admin/member framing (#1303)", () => {
  it("shows member-framed copy for the booking owner (default)", async () => {
    stubPreviewFetch();
    render(<CancelBookingButton bookingId="bk_1" />);

    const button = screen.getByRole("button", { name: "Cancel Booking" });
    expect(button).toBeTruthy();

    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Cancellation Summary")).toBeTruthy();
    });
    // The admin-on-behalf note must not appear for the owner.
    expect(screen.queryByText(/on behalf of the member/i)).toBeNull();
  });

  it("shows admin-on-behalf copy for a non-owner admin", async () => {
    stubPreviewFetch();
    render(<CancelBookingButton bookingId="bk_1" onBehalfOfMember />);

    const button = screen.getByRole("button", {
      name: "Cancel on behalf of member",
    });
    expect(button).toBeTruthy();

    fireEvent.click(button);

    await waitFor(() => {
      // Preview header is re-framed and an explicit admin note appears.
      expect(
        screen.getByText("Cancel on behalf of member", { selector: "p" })
      ).toBeTruthy();
    });
    expect(screen.getByText(/on behalf of the member/i)).toBeTruthy();
    expect(screen.getByText(/applied to the member.?s account/i)).toBeTruthy();
  });
});

describe("CancelBookingButton — per-cancel member-email choice (#1705)", () => {
  function stubPreviewAndCancelFetch() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("cancel-preview")) {
        return { ok: true, json: async () => previewBody };
      }
      return {
        ok: true,
        json: async () => ({ refundAmountCents: 4500, refundMethod: "card" }),
      };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    return { calls };
  }

  it("asks whether to email the member and posts notifyMember: false on 'Cancel without emailing'", async () => {
    const { calls } = stubPreviewAndCancelFetch();
    render(
      <CancelBookingButton bookingId="bk_1" onBehalfOfMember canChooseMemberEmail />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" })
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Confirm Cancellation" })
      ).toBeTruthy();
    });

    // Confirm opens the choice dialog; nothing is posted yet.
    fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));
    expect(
      screen.getByText("Email the member about this cancellation?")
    ).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/cancel"))).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel without emailing" })
    );
    await waitFor(() => {
      expect(
        screen.getByText(/was not emailed about this cancellation/i)
      ).toBeTruthy();
    });
    // The suppressed run must not promise a confirmation email.
    expect(screen.queryByText(/confirmation email shortly/i)).toBeNull();
    const post = calls.find((c) => c.url.endsWith("/cancel"));
    expect(post).toBeDefined();
    expect(JSON.parse(String(post!.init!.body))).toEqual({
      refundMethod: "card",
      notifyMember: false,
    });
  });

  it("posts notifyMember: true on 'Cancel and email member'", async () => {
    const { calls } = stubPreviewAndCancelFetch();
    render(
      <CancelBookingButton bookingId="bk_1" onBehalfOfMember canChooseMemberEmail />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" })
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Confirm Cancellation" })
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel and email member" })
    );

    await waitFor(() => {
      expect(screen.getByText(/confirmation email shortly/i)).toBeTruthy();
    });
    const post = calls.find((c) => c.url.endsWith("/cancel"));
    expect(post).toBeDefined();
    expect(JSON.parse(String(post!.init!.body))).toEqual({
      refundMethod: "card",
      notifyMember: true,
    });
  });

  it("keeps the immediate always-notify confirm for a member self-cancel (no dialog, no flag)", async () => {
    const { calls } = stubPreviewAndCancelFetch();
    render(<CancelBookingButton bookingId="bk_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Booking" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Confirm Cancellation" })
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));

    await waitFor(() => {
      expect(screen.getByText(/confirmation email shortly/i)).toBeTruthy();
    });
    const post = calls.find((c) => c.url.endsWith("/cancel"));
    expect(post).toBeDefined();
    // No dialog was shown and no flag rides on the member request.
    expect(JSON.parse(String(post!.init!.body))).toEqual({
      refundMethod: "card",
    });
    expect(
      screen.queryByText("Email the member about this cancellation?")
    ).toBeNull();
  });
});

describe("CancelBookingButton — restored applied credit on a no-payment cancel (#1547)", () => {
  const noPaymentWithRestore = {
    refundAmountCents: 0,
    keptAmountCents: 0,
    changeFeeCents: 0,
    refundPercentage: 0,
    creditRefundAmountCents: 0,
    creditRefundPercentage: 0,
    creditRestoredCents: 3000,
    totalPaidCents: 0,
    hasPayment: false,
  };

  it("shows the will-be-returned line under 'no payment taken' for the owner", async () => {
    stubPreviewFetch(noPaymentWithRestore);
    render(<CancelBookingButton bookingId="bk_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Booking" }));

    await waitFor(() => {
      expect(
        screen.getByText(/No payment has been taken for this booking/i)
      ).toBeTruthy();
    });
    expect(
      screen.getByText(
        /previously applied account credit will be returned to your account/i
      )
    ).toBeTruthy();
  });

  it("frames the restored-credit line for the member when an admin cancels on their behalf", async () => {
    stubPreviewFetch(noPaymentWithRestore);
    render(<CancelBookingButton bookingId="bk_1" onBehalfOfMember />);

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" })
    );

    await waitFor(() => {
      expect(
        screen.getByText(/No payment has been taken for this booking/i)
      ).toBeTruthy();
    });
    expect(
      screen.getByText(/will be returned to the member.?s account/i)
    ).toBeTruthy();
  });
});
