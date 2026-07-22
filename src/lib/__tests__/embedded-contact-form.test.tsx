// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";
import type { EmbeddedBodyPart } from "@/lib/page-content-embeds";
import type { ClubIdentity } from "@/config/club-identity-types";

// Regression guard: the live /contact page renders the {{contact-form}} EMBED,
// not ContactPageClient directly. The embed must forward `lodge` and
// `contactRoleKey`, or the Club Details box silently drops the address and shows
// the booking officer regardless of the admin's Club Contact selection.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

const MEMBERS = [
  {
    id: "m1",
    role: "Booking Officer",
    roleKey: "booking-officer",
    name: "Ann Lee",
    phone: "021 000 001",
    contactKey: "assign-bookings",
  },
  {
    id: "m2",
    role: "Secretary",
    roleKey: "secretary",
    name: "Bo Tan",
    phone: null,
    contactKey: "assign-secretary",
  },
];

const club = {
  name: "Example Club",
  publicUrl: "https://example.org",
  socialLinks: { facebook: "https://facebook.com/example" },
} as unknown as ClubIdentity;

const contactFormPart = { type: "contact-form" } as EmbeddedBodyPart;

describe("EmbeddedPageContentParts contact-form forwarding", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ members: MEMBERS }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards lodge address and the configured contact role to the form", async () => {
    render(
      <EmbeddedPageContentParts
        parts={[contactFormPart]}
        pageSlug="contact"
        clubIdentity={club}
        lodge={{ name: "Alpine Lodge", address: "1 Mountain Rd, Ruapehu" }}
        contactRoleKey="secretary"
      />,
    );

    await waitFor(() => expect(screen.getByText("Secretary")).toBeTruthy());
    expect(screen.getByText("Bo Tan")).toBeTruthy();
    expect(screen.getByText("1 Mountain Rd, Ruapehu")).toBeTruthy();
    // The configured role replaced the booking-officer fallback.
    expect(screen.queryByText("Booking Officer")).toBeNull();
  });

  it("falls back to the booking officer when no role is threaded", async () => {
    render(
      <EmbeddedPageContentParts
        parts={[contactFormPart]}
        pageSlug="contact"
        clubIdentity={club}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Booking Officer")).toBeTruthy(),
    );
    expect(screen.getByText("Ann Lee")).toBeTruthy();
  });
});
