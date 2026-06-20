// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Stripe Elements components pull in @stripe/* which needs a live publishable
// key and a browser; stub them so the settle card renders in jsdom.
vi.mock("@/components/stripe/StripeProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-provider">{children}</div>
  ),
}));
vi.mock("@/components/stripe/PaymentForm", () => ({
  default: () => <div data-testid="payment-form">Card form</div>,
}));

import { OrganiserGroupBookingCard } from "@/components/group-booking/organiser-group-booking-card";
import type { OrganiserGroupState } from "@/components/group-booking/organiser-group-booking-card";

function group(overrides: Partial<OrganiserGroupState> = {}): OrganiserGroupState {
  return {
    code: "ABCD2345",
    status: "OPEN",
    paymentMode: "ORGANISER_PAYS",
    joinDeadline: null,
    maxJoiners: null,
    joiners: [
      {
        id: "j1",
        name: "Jo Member",
        guestCount: 1,
        status: "CONFIRMED",
        priceCents: 4500,
        isMember: true,
      },
    ],
    settlement: null,
    ...overrides,
  };
}

function stubFetch(opts: {
  internetBankingEnabled?: boolean;
  settleBody?: Record<string, unknown>;
  settleOk?: boolean;
}) {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u.includes("/settle") && init?.method === "POST") {
      return {
        ok: opts.settleOk ?? true,
        json: async () => opts.settleBody ?? {},
      } as Response;
    }
    if (u.includes("/api/payments/options")) {
      return {
        ok: true,
        json: async () => ({
          methods: {
            stripe: { enabled: true },
            internetBanking: { enabled: opts.internetBankingEnabled ?? false },
          },
        }),
      } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OrganiserGroupBookingCard settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers internet banking and shows the invoice reference after settling", async () => {
    const fetchMock = stubFetch({
      internetBankingEnabled: true,
      settleBody: {
        outcome: "invoice_sent",
        amountCents: 4500,
        childCount: 1,
        reference: "GROUP-ABCD1234",
      },
    });

    render(
      <OrganiserGroupBookingCard
        bookingId="booking-1"
        canOpenGroup={false}
        group={group()}
      />
    );

    // The Internet Banking option appears once the module flag resolves.
    fireEvent.click(await screen.findByRole("button", { name: /Internet Banking/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Settle by invoice \(emailed\)/ })
    );

    // Confirms in place with the GROUP- reference, no Stripe form.
    expect(await screen.findByText(/Invoice emailed/)).toBeDefined();
    expect(screen.getByText(/GROUP-ABCD1234/)).toBeDefined();
    expect(screen.queryByTestId("payment-form")).toBeNull();

    const settleCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes("/settle") && init?.method === "POST"
    );
    expect(settleCall).toBeDefined();
    expect(
      JSON.parse((settleCall![1] as { body: string }).body).paymentMethod
    ).toBe("internet_banking");
  });

  it("hides the internet banking option and uses the card flow when the module is off", async () => {
    const fetchMock = stubFetch({
      internetBankingEnabled: false,
      settleBody: {
        outcome: "ready",
        amountCents: 4500,
        childCount: 1,
        clientSecret: "cs_settle_1",
      },
    });

    render(
      <OrganiserGroupBookingCard
        bookingId="booking-1"
        canOpenGroup={false}
        group={group()}
      />
    );

    const settleButton = await screen.findByRole("button", {
      name: /Settle group total/,
    });
    expect(screen.queryByRole("button", { name: /Internet Banking/ })).toBeNull();

    fireEvent.click(settleButton);

    // Stripe Elements render for the card flow.
    expect(await screen.findByTestId("payment-form")).toBeDefined();

    await waitFor(() => {
      const settleCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url).includes("/settle") && init?.method === "POST"
      );
      expect(settleCall).toBeDefined();
      expect(
        JSON.parse((settleCall![1] as { body: string }).body).paymentMethod
      ).toBe("stripe");
    });
  });
});
