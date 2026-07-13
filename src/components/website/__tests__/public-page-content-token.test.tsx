import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MembershipTypesToken } from "@/components/website/public-page-content-token";
import { BookingPolicyToken, CancellationPolicyToken } from "@/components/website/public-page-content-token";

describe("public PageContent token rendering", () => {
  it("escapes hostile persisted display strings", () => {
    const html = renderToStaticMarkup(<MembershipTypesToken items={[{
      name: '<script>alert("name")</script>',
      description: '<img src=x onerror="alert(1)">',
      annualFee: { amountCents: 1000, label: "$10.00" },
      billingLabel: "Per member; no proration",
    }]} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("renders safe empty states for empty booking and cancellation policies", () => {
    const booking = renderToStaticMarkup(<BookingPolicyToken policy={{ lodge: null, hold: null, periods: [], minimumStays: [], groupDiscount: null }} />);
    const cancellation = renderToStaticMarkup(<CancellationPolicyToken policy={{ lodge: null, tiers: [], periods: [] }} />);
    expect(booking).toContain("No public information is currently available.");
    expect(cancellation).toContain("No public information is currently available.");
  });
});
