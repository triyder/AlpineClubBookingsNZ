// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPage: vi.fn(), buildBody: vi.fn() }));
vi.mock("@/lib/page-content-html", () => ({
  getSanitizedPageContentByPath: mocks.getPage,
  pageContentHtmlToPlainText: () => "",
}));
vi.mock("@/lib/page-content-embeds", () => ({ buildEmbeddedBody: mocks.buildBody }));
vi.mock("@/lib/auth-redirect", () => ({ buildBookingLoginPath: () => "/login" }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));
vi.mock("@/app/(website)/contact/contact-page-client", () => ({ ContactPageClient: () => <div>Contact form</div> }));
vi.mock("@/app/(website)/join/apply/join-apply-page-client", () => ({ JoinApplyPageClient: () => <div>Join form</div> }));
vi.mock("@/components/website/committee-members-grid", () => ({ CommitteeMembersGrid: () => <div>Committee</div> }));
vi.mock("@/components/website/photo-gallery-token", () => ({ PhotoGalleryToken: () => <div>Gallery</div> }));
vi.mock("@/components/website/skifield-conditions-widget", () => ({ SkifieldConditionsWidget: () => <div>Conditions</div> }));
vi.mock("@/components/website/skifield-whakapapa-widget", () => ({ SkifieldWhakapapaWidget: () => <div>Whakapapa</div> }));

import HomePage from "@/app/(website)/page";
import DynamicWebsitePage from "@/app/(website)/[...slug]/page";
import ContactPage from "@/app/(website)/contact/page";
import NotFoundPage from "@/app/not-found";

const page = {
  id: "page-1", slug: "content", caption: "Info", menuTitle: "Info",
  title: "Public information", headerText: "<p>Header</p>", path: "/content",
  sortOrder: 1, contentHtml: "{{membership-types}}", published: true,
};
const parts = [
  { type: "membership-types" as const, items: [{ name: "Public membership", description: "Description", annualFee: null, billingLabel: "No invoice required" }] },
  { type: "entrance-fees" as const, items: [{ category: "Adult", fee: { amountCents: 1000, label: "$10.00" } }] },
  { type: "hut-fees" as const, lodges: [{ name: "River Lodge", slug: "river", seasons: [] }] },
  { type: "booking-policy-summary" as const, policy: { lodge: { name: "River Lodge", slug: "river" }, hold: "Non-member bookings are not held provisionally.", periods: [], minimumStays: [], groupDiscount: null } },
  { type: "cancellation-policy" as const, policy: { lodge: { name: "River Lodge", slug: "river" }, tiers: [{ description: "7 or more days before check-in: 100% refund" }, { description: "After check-in: no refund" }], periods: [] } },
];

describe("public PageContent data-token route parity", () => {
  beforeEach(() => {
    mocks.getPage.mockResolvedValue(page);
    mocks.buildBody.mockResolvedValue(parts);
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  async function expectPublicBlocks(node: React.ReactNode) {
    render(node);
    expect(screen.getByText("Public membership")).toBeTruthy();
    expect(screen.getByText("$10.00")).toBeTruthy();
    expect(screen.getAllByText("River Lodge").length).toBeGreaterThan(0);
    expect(screen.getByText("Non-member bookings are not held provisionally.")).toBeTruthy();
    expect(screen.getByText("After check-in: no refund")).toBeTruthy();
  }

  it("renders through home", async () => { await expectPublicBlocks(await HomePage()); });
  it("renders through the catch-all", async () => { await expectPublicBlocks(await DynamicWebsitePage({ params: Promise.resolve({ slug: ["content"] }) })); });
  it("renders through a code-backed route", async () => { await expectPublicBlocks(await ContactPage()); });
  it("renders through the database-backed 404", async () => { await expectPublicBlocks(await NotFoundPage()); });
});
