// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  XeroSuggestedContactCard,
  type XeroSearchResult,
} from "@/components/admin/xero-suggested-contact-card";

const baseContact: XeroSearchResult = {
  contactId: "xero-1",
  name: "Pat Example",
  email: "pat@example.test",
  isLinked: false,
  linkedMemberName: null,
};

describe("XeroSuggestedContactCard", () => {
  it("renders the contact name and email", () => {
    render(
      <XeroSuggestedContactCard
        contact={baseContact}
        radioName="suggested"
        checked={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("Pat Example")).toBeDefined();
    expect(screen.getByText("pat@example.test")).toBeDefined();
  });

  it("renders match-reason badges when provided", () => {
    render(
      <XeroSuggestedContactCard
        contact={{
          ...baseContact,
          matchReasons: ["Name match", "Email match"],
        }}
        radioName="suggested"
        checked={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("Name match")).toBeDefined();
    expect(screen.getByText("Email match")).toBeDefined();
  });

  it("disables the radio and shows the linked-member warning for linked contacts", () => {
    render(
      <XeroSuggestedContactCard
        contact={{
          ...baseContact,
          isLinked: true,
          linkedMemberName: "Sam Existing",
        }}
        radioName="suggested"
        checked={false}
        onSelect={() => {}}
      />,
    );
    const radio = screen.getByRole("radio") as HTMLInputElement;
    expect(radio.disabled).toBe(true);
    expect(screen.getByText("Already linked to Sam Existing")).toBeDefined();
  });

  it("renders the View in Xero link when xeroLink is provided", () => {
    render(
      <XeroSuggestedContactCard
        contact={{
          ...baseContact,
          xeroLink: "https://go.xero.com/contacts/xero-1",
        }}
        radioName="suggested"
        checked={false}
        onSelect={() => {}}
      />,
    );
    const link = screen.getByRole("link", { name: /View in Xero/i }) as HTMLAnchorElement;
    expect(link.href).toBe("https://go.xero.com/contacts/xero-1");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("invokes onSelect when the radio is clicked", () => {
    const onSelect = vi.fn();
    render(
      <XeroSuggestedContactCard
        contact={baseContact}
        radioName="suggested"
        checked={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("radio"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("uses the given radio name so callers can isolate form groups", () => {
    render(
      <XeroSuggestedContactCard
        contact={baseContact}
        radioName="member-detail-potential-xero-contact"
        checked={true}
        onSelect={() => {}}
      />,
    );
    const radio = screen.getByRole("radio") as HTMLInputElement;
    expect(radio.name).toBe("member-detail-potential-xero-contact");
    expect(radio.checked).toBe(true);
  });
});
