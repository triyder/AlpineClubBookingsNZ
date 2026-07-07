import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(),
}));

import AppearanceHubPage from "@/app/(admin)/admin/appearance/page";
import BookingsSetupHubPage from "@/app/(admin)/admin/bookings-setup/page";
import IntegrationsHubPage from "@/app/(admin)/admin/integrations/page";
import MembershipSetupHubPage from "@/app/(admin)/admin/membership-setup/page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

async function renderPage(Page: () => Promise<React.ReactNode>) {
  return renderToStaticMarkup(await Page());
}

describe("admin setup hub pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue(allOn);
  });

  it("renders the Membership & Members hub cards", async () => {
    const html = await renderPage(MembershipSetupHubPage);

    expect(html).toContain("Membership &amp; Members");
    expect(html).toContain("Membership Types");
    expect(html).toContain("Member Fields");
    expect(html).toContain("Subscription Lockout");
  });

  it("renders the Bookings Setup hub without the removed sidebar duplicate", async () => {
    const html = await renderPage(BookingsSetupHubPage);

    expect(html).toContain("Bookings Setup");
    expect(html).toContain("Rooms &amp; Beds");
    expect(html).toContain("Booking Messages");
  });

  it("shows feature-gated cards when their modules are enabled", async () => {
    const html = await renderPage(AppearanceHubPage);

    expect(html).toContain("Mountain Conditions");
    expect(html).toContain("/admin/mountain-conditions");
  });

  it("hides feature-gated cards when their modules are disabled", async () => {
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue({
      ...allOn,
      skifieldConditions: false,
    });

    const html = await renderPage(AppearanceHubPage);

    expect(html).not.toContain("Mountain Conditions");
    expect(html).not.toContain("/admin/mountain-conditions");
  });

  it("hides integration cards behind the existing Xero route gate", async () => {
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue({
      ...allOn,
      xeroIntegration: false,
    });

    const html = await renderPage(IntegrationsHubPage);

    expect(html).toContain("Integrations");
    expect(html).not.toContain("Xero Setup");
    expect(html).not.toContain("/admin/xero/setup");
  });
});
