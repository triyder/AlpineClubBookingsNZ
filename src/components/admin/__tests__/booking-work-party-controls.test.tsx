// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

import { BookingWorkPartyControls } from "@/components/admin/booking-work-party-controls";

/**
 * Fork #129: the settlement part of the "Add to work party" dialog. The
 * credit-or-card choice appears only where there is one to make (a card-paid
 * booking); an organiser-paid joiner gets a plain line saying where the money
 * goes; and a new choice re-runs the preview with it. The money itself is the
 * server's, proved in `work-party-booking-correction.realdb.test.ts`.
 */
const figures = (change: Record<string, unknown> = {}) => ({
  previousFinalPriceCents: 20_000,
  newFinalPriceCents: 15_000,
  priceDiffCents: -5_000,
  accountCreditAmountCents: 5_000,
  appliedCreditGivenBackCents: 0,
  refundedExcessCreditCents: 0,
  additionalAmountCents: 0,
  refundAmountCents: 0,
  settlementMethod: "credit",
  ...change,
});

const workParties = {
  currentWorkParty: null,
  workParties: [
    {
      id: "wp-1",
      name: "Spring Bee",
      startDate: "2026-08-02",
      endDate: "2026-08-03",
      discountPercent: 50,
      lodgeName: null,
      eligible: true,
      reason: null,
    },
  ],
};

let posts: Array<Record<string, unknown>> = [];

function serve(preview: (body: Record<string, unknown>) => Record<string, unknown>) {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}");
        posts.push(body);
        return new Response(JSON.stringify(preview(body)), { status: 200 });
      }
      return new Response(JSON.stringify(workParties), { status: 200 });
    }),
  );
}

async function openAndPreview() {
  render(<BookingWorkPartyControls bookingId="booking-1" />);
  fireEvent.click(screen.getByRole("button", { name: "Add to work party" }));
  const show = await screen.findByRole("button", { name: "Show the new total" });
  await waitFor(() => expect(show).toBeEnabled());
  fireEvent.click(show);
  await screen.findByTestId("work-party-figures");
}

beforeEach(() => {
  posts = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BookingWorkPartyControls settlement (#129)", () => {
  it("offers Club credit and Refund to card on a card-paid booking, and re-runs the preview on a new choice", async () => {
    serve((body) => ({
      outcome: "quoted",
      figures:
        body.settlementMethod === "card"
          ? figures({ accountCreditAmountCents: 0, refundAmountCents: 5_000, settlementMethod: "card" })
          : figures(),
      settlementOptions: { methods: ["credit", "card"], paidByOrganiser: false },
    }));
    await openAndPreview();
    expect(screen.getByRole("group", { name: "How the discount comes back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Club credit/ })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: /Refund to card/ }));
    await screen.findByText(/Refunded to card:/);
    expect(posts.at(-1)).toMatchObject({ mode: "preview", settlementMethod: "card" });
    expect(screen.getByRole("button", { name: /Refund to card/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/Account credit to the member/)).not.toBeInTheDocument();
  });

  it("shows no choice where only club credit is offered", async () => {
    serve(() => ({
      outcome: "quoted",
      figures: figures(),
      settlementOptions: { methods: ["credit"], paidByOrganiser: false },
    }));
    await openAndPreview();
    expect(screen.queryByRole("group", { name: "How the discount comes back" })).not.toBeInTheDocument();
    expect(screen.getByText(/Account credit to the member/)).toBeInTheDocument();
  });

  it("shows an organiser-paid joiner's one disposition as a line, never as a choice", async () => {
    serve(() => ({
      outcome: "quoted",
      figures: figures({ accountCreditAmountCents: 0, refundAmountCents: 5_000, settlementMethod: "card" }),
      settlementOptions: { methods: ["card"], paidByOrganiser: true },
    }));
    await openAndPreview();
    expect(screen.queryByRole("group", { name: "How the discount comes back" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Refund to card/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("work-party-organiser-disposition")).toHaveTextContent(
      /goes to the organiser, the way they paid: to their card, or by bank transfer/,
    );
    expect(screen.getByText(/Returned to the group organiser:/)).toBeInTheDocument();
  });
});

describe("Remove from work party (#130)", () => {
  const removal = figures({
    previousFinalPriceCents: 15_000,
    newFinalPriceCents: 20_000,
    priceDiffCents: 5_000,
    accountCreditAmountCents: 0,
    additionalAmountCents: 5_000,
    settlementMethod: null,
  });

  it("offers Remove instead of Add on a booking that carries a work party, and previews it", async () => {
    serve(() => ({ outcome: "quoted", figures: removal }));
    render(<BookingWorkPartyControls bookingId="booking-1" currentWorkParty={{ id: "wp-1", name: "Spring Bee" }} />);
    expect(screen.queryByRole("button", { name: "Add to work party" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove from work party" }));
    const shown = await screen.findByTestId("work-party-remove-figures");
    expect(shown).toHaveTextContent("Added to what is owed on the booking");
    expect(shown).toHaveTextContent("Asked of the member now");
    expect(posts).toEqual([{ mode: "preview", action: "remove", workPartyEventId: "wp-1" }]);
  });

  it("applies with the figures it showed, and no settlement method", async () => {
    serve((body) => (body.mode === "apply" ? { outcome: "applied", figures: removal } : { outcome: "quoted", figures: removal }));
    render(<BookingWorkPartyControls bookingId="booking-1" currentWorkParty={{ id: "wp-1", name: "Spring Bee" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove from work party" }));
    await screen.findByTestId("work-party-remove-figures");
    fireEvent.click(screen.getByRole("button", { name: "Remove without emailing" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({
      mode: "apply",
      action: "remove",
      workPartyEventId: "wp-1",
      notifyMember: false,
      expectedFigures: removal,
    });
  });
});
