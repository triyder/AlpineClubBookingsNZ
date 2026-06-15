// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContactPageClient } from "@/app/(website)/contact/contact-page-client";
import type { ClubIdentity } from "@/config/club-identity-types";

// Controllable search params: mutate nav.search then (re)render to simulate a
// same-route client navigation that changes ?recipient= without remounting the
// form (e.g. a sidebar "Send a message" link to /contact?recipient=<key>).
const nav = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// Radix Select is portal/pointer based and not assertable in jsdom, so mock it
// to surface the controlled value (mirrors member-import-dialog.test.tsx).
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, children }: { value?: string; children: ReactNode }) => (
    <div data-testid="recipient-select" data-value={value}>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

const MEMBERS = [
  {
    id: "m1",
    role: "President",
    name: "Ann Lee",
    phone: "021 000 001",
    email: "president@example.org",
    contactKey: "president",
  },
  {
    id: "m2",
    role: "Secretary",
    name: "Bo Tan",
    phone: "021 000 002",
    email: "secretary@example.org",
    contactKey: "secretary",
  },
];

const club = {
  name: "Example Club",
  publicUrl: "https://example.org",
  socialLinks: { facebook: "https://facebook.com/example" },
} as unknown as ClubIdentity;

function recipientValue() {
  return screen.getByTestId("recipient-select").getAttribute("data-value");
}

describe("ContactPageClient recipient pre-selection", () => {
  beforeEach(() => {
    nav.search = "";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ members: MEMBERS }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pre-selects the committee member named in ?recipient= once members load", async () => {
    nav.search = "recipient=secretary";
    render(<ContactPageClient club={club} />);
    await waitFor(() => expect(recipientValue()).toBe("secretary"));
  });

  it("re-syncs the Send to value when ?recipient= changes on the same route", async () => {
    // Landed on /contact with no recipient -> defaults to General enquiry.
    const { rerender } = render(<ContactPageClient club={club} />);
    await waitFor(() => expect(recipientValue()).toBe("general"));

    // A sidebar "Send a message" link navigates to ?recipient=president without
    // remounting the form. The select must follow (this is the reported bug).
    nav.search = "recipient=president";
    rerender(<ContactPageClient club={club} />);
    await waitFor(() => expect(recipientValue()).toBe("president"));
  });

  it("falls back to General for an unknown recipient once members load", async () => {
    nav.search = "recipient=not-a-real-key";
    render(<ContactPageClient club={club} />);
    await waitFor(() => expect(recipientValue()).toBe("general"));
  });
});
