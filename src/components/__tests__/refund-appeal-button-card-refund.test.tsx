// @vitest-environment jsdom

/**
 * #4124: the appeal form's maximum nets a card refund not yet made to the
 * owner. The form says so beside the maximum, so the lower figure is not
 * a mystery; with nothing not yet made it says nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { RefundAppealButton } from "@/components/refund-appeal-button";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockResolvedValue({ json: async () => [] });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openForm(cardRefundOwedCents?: number) {
  render(<RefundAppealButton bookingId="booking-1" maxRefundableCents={7500} cardRefundOwedCents={cardRefundOwedCents} />);
  fireEvent.click(await screen.findByRole("button", { name: "Request Refund Appeal" }));
}

describe("refund appeal form, a card refund not yet made (#4124)", () => {
  it("says how much is still being refunded to the card beside the maximum", async () => {
    await openForm(2500);

    expect(screen.getByText(/maximum \$75\.00/)).toBeTruthy();
    const note = screen.getByText("$25.00 is still owed back to you, so it is not part of this maximum.");
    // It describes the amount box, beside the maximum.
    const box = screen.getByRole("textbox", { name: /Requested amount/i });
    expect(box.getAttribute("aria-describedby")?.split(" ")).toContain(note.id);
  });

  it("CONTROL: says nothing when no card refund is not yet made", async () => {
    await openForm();

    expect(screen.queryByText(/still owed back/)).toBeNull();
    expect(screen.getByRole("textbox", { name: /Requested amount/i }).getAttribute("aria-describedby")).not.toContain("card-refund");
  });
});
