// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSiteFooterContent: vi.fn(),
}));

vi.mock("@/config/club-identity", () => ({
  CLUB_NAME: "Test Alpine Club",
}));

vi.mock("@/components/website-logo", () => ({
  WebsiteLogo: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("@/lib/site-content", () => ({
  getSiteFooterContent: mocks.getSiteFooterContent,
}));

import { WebsiteFooter } from "@/components/website-footer";

describe("WebsiteFooter", () => {
  it("renders admin-managed footer sections beside code-managed legal links", async () => {
    mocks.getSiteFooterContent.mockResolvedValue({
      blurbHtml: "<p>Admin blurb</p>",
      quickLinksHtml: "<h3>Quick Links</h3><ul><li>About</li></ul>",
      affiliationsHtml: "<h3>Affiliations</h3><ul><li>FMC</li></ul>",
    });

    render(await WebsiteFooter({ pageSlug: "home", logoDataUrl: null }));

    expect(screen.getByText("Test Alpine Club")).toBeTruthy();
    expect(screen.getByText("Admin blurb")).toBeTruthy();
    expect(screen.getByText("Quick Links")).toBeTruthy();
    expect(screen.getByText("Affiliations")).toBeTruthy();
    // Section headings are demoted h3 -> h2 at render time so they sit under
    // the page <h1> without skipping a level (axe heading-order).
    expect(
      screen.getByRole("heading", { level: 2, name: "Quick Links" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Affiliations" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href"),
    ).toBe("/privacy");
    expect(
      screen.getByRole("link", { name: "Terms of Service" }).getAttribute(
        "href",
      ),
    ).toBe("/terms");
  });

  it("hides empty admin-managed link columns while keeping the logo column", async () => {
    mocks.getSiteFooterContent.mockResolvedValue({
      blurbHtml: "",
      quickLinksHtml: "",
      affiliationsHtml: "<h3>Affiliations</h3>",
    });

    render(await WebsiteFooter({ pageSlug: "home", logoDataUrl: null }));

    expect(screen.getByText("Test Alpine Club")).toBeTruthy();
    expect(screen.queryByText("Quick Links")).toBeNull();
    expect(screen.getByText("Affiliations")).toBeTruthy();
  });
});
