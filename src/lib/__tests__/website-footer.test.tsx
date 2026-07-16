// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSiteFooterContent: vi.fn(),
  getCachedClubIdentity: vi.fn(),
}));

vi.mock("@/components/website-logo", () => ({
  WebsiteLogo: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("@/lib/site-content", () => ({
  getSiteFooterContent: mocks.getSiteFooterContent,
}));

// Footer identity is DB-first (E3 #1929): the club name in the logo label and
// the copyright line comes from getCachedClubIdentity(), not the static
// CLUB_NAME. A rename in the DB must reach the footer.
vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: mocks.getCachedClubIdentity,
}));

import { WebsiteFooter } from "@/components/website-footer";

describe("WebsiteFooter", () => {
  beforeEach(() => {
    mocks.getCachedClubIdentity.mockResolvedValue({ name: "Test Alpine Club" });
  });

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

  it("reflects a DB-first club rename in the logo label and copyright", async () => {
    mocks.getCachedClubIdentity.mockResolvedValue({ name: "Renamed Ski Club" });
    mocks.getSiteFooterContent.mockResolvedValue({
      blurbHtml: "",
      quickLinksHtml: "",
      affiliationsHtml: "",
    });

    render(await WebsiteFooter({ pageSlug: "home", logoDataUrl: null }));

    expect(screen.getByText("Renamed Ski Club")).toBeTruthy();
    expect(
      screen.getByText(/Renamed Ski Club Incorporated\. All\s+rights reserved\./),
    ).toBeTruthy();
  });
});
