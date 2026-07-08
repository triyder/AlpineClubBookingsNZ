import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackLink } from "@/components/admin/back-link";

describe("BackLink", () => {
  it("renders the ← affordance, the label, and the parent-hub href", () => {
    const html = renderToStaticMarkup(
      <BackLink href="/admin/booking-policies" label="Booking Policies" />,
    );

    expect(html).toContain('href="/admin/booking-policies"');
    expect(html).toContain("← Booking Policies");
  });

  it("applies the shared Booking-Policies underline styling", () => {
    const html = renderToStaticMarkup(
      <BackLink href="/admin/health" label="System Health" />,
    );

    expect(html).toContain(
      "text-sm font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4",
    );
  });

  it("renders an ampersand in the label without double-escaping", () => {
    const html = renderToStaticMarkup(
      <BackLink href="/admin/notifications" label="Notifications & Email" />,
    );

    expect(html).toContain("← Notifications &amp; Email");
    expect(html).not.toContain("&amp;amp;");
  });
});
