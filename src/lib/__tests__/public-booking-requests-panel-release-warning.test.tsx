// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicBookingRequestsPanel } from "@/components/admin/booking-requests/public-booking-requests-panel";

// next/navigation: the panel replaces the URL in an effect and reads search params.
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Radix Select needs jsdom polyfills the suite does not provide; stub it out —
// the pricing-mode picker is irrelevant to the release-hold warning under test.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

// The contact picker is not rendered while a hold exists; stub it defensively.
vi.mock("@/components/admin/booking-requests/booking-request-contact-picker", () => ({
  BookingRequestContactPicker: () => <div data-testid="contact-picker" />,
}));

// The panel reads the configurable hut-leader label via useClubIdentity, which
// throws outside a ClubIdentityProvider; stub it with the default label.
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
  ClubIdentityProvider: ({ children }: { children: ReactNode }) => children,
}));

// A general request that HAS a held booking and is in a whitelisted status, so
// the read-only note + "Release hold" action render.
const heldRequest = {
  id: "req-1",
  type: "GENERAL",
  status: "QUOTE_SENT",
  schoolName: null,
  cateringPreference: null,
  teachers: [],
  linkedGuestMembers: [],
  contactFirstName: "Ada",
  contactLastName: "Lovelace",
  contactEmail: "ada@example.com",
  contactPhone: null,
  checkIn: "2026-08-01",
  checkOut: "2026-08-03",
  guests: [],
  message: null,
  indicativePriceCents: null,
  priceCents: null,
  verifiedAt: null,
  pricedAt: null,
  pricedByMemberId: null,
  pricedByMemberName: null,
  reviewedAt: null,
  reviewedByMemberId: null,
  reviewedByMemberName: null,
  declineReason: null,
  convertedBookingId: null,
  attendeesConfirmedAt: null,
  convertedMemberId: null,
  heldBookingId: "held-1",
  acceptedQuoteOptionId: null,
  acceptedPriceCents: null,
  acceptedAt: null,
  responseMessage: null,
  responseMessageAt: null,
  latestQuote: null,
  createdAt: "2026-07-01T00:00:00.000Z",
};

describe("PublicBookingRequestsPanel release-hold warning (#1255 RR-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [heldRequest] }),
    }) as unknown as typeof fetch;
  });

  it("surfaces the quote-link warning in the Release-hold confirm before confirming", async () => {
    render(<PublicBookingRequestsPanel />);

    // Wait for the fetched request to render its Release-hold action.
    const releaseButton = await screen.findByRole("button", { name: "Release hold" });

    // The warning is only shown once the admin opens the confirm step.
    expect(screen.queryByText(/existing quote link/i)).toBeNull();

    fireEvent.click(releaseButton);

    await waitFor(() => {
      expect(
        screen.getByText(/the requester's existing quote link\s+stays active/i),
      ).toBeTruthy();
    });
    // And it advises the mitigation (re-send a fresh quote after re-mapping).
    expect(screen.getByText(/re-send a fresh quote after/i)).toBeTruthy();
    // The confirm action is present alongside the warning.
    expect(screen.getByRole("button", { name: "Confirm release" })).toBeTruthy();
  });
});
