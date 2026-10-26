// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render as renderInteractive, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/additional-payment-card", () => ({ AdditionalPaymentCard: ({ additionalAmountCents }: { additionalAmountCents: number }) => <p>Card ask {additionalAmountCents}</p> }));
import { BookingOutstandingPayments } from "../_components/booking-outstanding-payments";
import type { BookingOutstandingPaymentView } from "@/lib/booking-outstanding-payment";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { requireClubTimeZone } from "@/lib/club-time";
const base: Extract<BookingOutstandingPaymentView, { kind: "ready" }> = {
  kind: "ready", audience: "owner", bookingStatus: "COMPLETED", revision: "revision", cardDueCents: 0, cardRevision: "card", incomplete: false, nextCursor: null,
  observations: [{ kind: "payable", invoiceId: "supplement", invoiceNumber: "INV-EXTRA", reference: "Supplementary booking", dueCents: 1234, observedAt: "2026-07-01T00:00:00Z" }],
};
const render = (initial: BookingOutstandingPaymentView) => renderToStaticMarkup(<BookingOutstandingPayments bookingId="booking" initial={initial} format={CLUB_FORMAT_TEST} zone={requireClubTimeZone("Pacific/Auckland")} />);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); refresh.mockReset(); });
describe("individual outstanding amounts and audience", () => {
  it("shows remaining amount, correct supplementary invoice and bank-payment instructions", () => {
    const html = render(base);
    expect(html).toContain("$12.34"); expect(html).toContain("INV-EXTRA"); expect(html).toContain("internet banking"); expect(html).toContain("bank details on that invoice");
    expect(html).not.toContain("No payment"); expect(html).not.toContain("Card ask");
  });
  it("shows every independent demand without a combined total", () => {
    const html = render({ ...base, observations: [...base.observations, { ...base.observations[0]!, invoiceId: "second", invoiceNumber: "INV-SECOND", kind: "payable", dueCents: 5678, reference: null }] });
    expect(html).toContain("$56.78"); expect(html).toContain("INV-SECOND"); expect(html).not.toContain("$69.12");
  });
  it("links the owner to their actual card, with a read-only officer audience", () => {
    expect(render({ ...base, cardDueCents: 2500 })).toContain("Checking current additional card payment details");
    expect(render({ ...base, cardDueCents: 2500 })).toContain("Card ask 2500");
    const officer = render({ ...base, audience: "officer", cardDueCents: 2500 });
    expect(officer).toContain("Our records list"); expect(officer).not.toContain("Card ask"); expect(officer).not.toContain('href="#additional-payment"');
    expect(render({ kind: "hidden" })).toBe("");
  });
  it("never labels incomplete or withdrawn evidence settled", () => {
    const html = render({ ...base, observations: [], incomplete: true, nextCursor: "signed" });
    expect(html).toContain("cannot yet be confirmed"); expect(html).toContain("Check more invoices"); expect(html).not.toContain("nothing");
    expect(render({ ...base, observations: [{ kind: "retired", invoiceId: "supplement", invoiceNumber: "INV-EXTRA", status: "VOIDED", observedAt: "2026-07-01T00:00:00Z" }] })).toContain("replacement amount");
  });
  it.each(["network", "HTTP 503"])("separates a failed continuation (%s) from the last card observation and offers current-authority retry", async (failure) => {
    const fetch = failure === "network" ? vi.fn().mockRejectedValue(new Error("Connection lost")) : vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    renderInteractive(<BookingOutstandingPayments bookingId="booking" initial={{ ...base, cardDueCents: 2500, nextCursor: "signed" }} format={CLUB_FORMAT_TEST} zone={requireClubTimeZone("Pacific/Auckland")} />);
    expect(screen.getByText("Card ask 2500")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check more invoices" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Our records last listed an additional card amount of $25.00");
    expect(alert).toHaveTextContent("current payment status could not be confirmed");
    expect(screen.queryByText("Card ask 2500")).not.toBeInTheDocument();
    expect(screen.queryByText(/You have an additional card payment/)).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("cursor=signed"), { cache: "no-store" });
    expect(refresh).not.toHaveBeenCalled();
    const retry = await screen.findByRole("button", { name: "Check current payment information" });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("link", { name: "Reload this booking" })).toHaveAttribute("href", "/bookings/booking");
  });
  it.each([2500, 0, null])("uses the revalidated server view after failure, including captured or withdrawn asks (current amount %s)", async (cardDueCents) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection lost")));
    const component = (key: string, initial: BookingOutstandingPaymentView) => <BookingOutstandingPayments key={key} bookingId="booking" initial={initial} format={CLUB_FORMAT_TEST} zone={requireClubTimeZone("Pacific/Auckland")} />;
    const { rerender } = renderInteractive(component("before", { ...base, cardDueCents: 2500, nextCursor: "signed" }));
    fireEvent.click(screen.getByRole("button", { name: "Check more invoices" }));
    await screen.findByRole("alert");
    // BookingStatusSection keys a refreshed view, so a new server observation
    // replaces local uncertainty rather than treating the old card as current.
    rerender(component("revalidated", cardDueCents === null ? { kind: "hidden" } : { ...base, cardDueCents, cardRevision: "current-card" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Card ask 2500") !== null).toBe(cardDueCents !== null && cardDueCents > 0);
    expect(screen.queryByText(/last checked additional card/)).not.toBeInTheDocument();
  });
});
