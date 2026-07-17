import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BookingPolicyToken,
  CancellationPolicyToken,
  FeeGroupsToken,
} from "@/components/website/public-page-content-token";

describe("public PageContent token rendering", () => {
  it("escapes hostile persisted display strings in the grouped fee renderer", () => {
    const html = renderToStaticMarkup(
      <FeeGroupsToken
        groups={[{
          heading: '<script>alert("h")</script>',
          rows: [{ label: '<img src=x onerror="alert(1)">', audience: "Member", fee: { amountCents: 1000, label: "$10.00" } }],
        }]}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).toContain("$10.00");
  });

  it("renders the shared empty state when there are no populated groups", () => {
    const noGroups = renderToStaticMarkup(<FeeGroupsToken groups={[]} />);
    const emptyRows = renderToStaticMarkup(<FeeGroupsToken groups={[{ heading: "Full", rows: [] }]} />);
    expect(noGroups).toContain("No public information is currently available.");
    expect(emptyRows).toContain("No public information is currently available.");
  });

  it("renders one section per populated group with an optional audience qualifier", () => {
    const html = renderToStaticMarkup(
      <FeeGroupsToken
        groups={[
          { heading: "Full", rows: [{ label: "Adult", fee: { amountCents: 12500, label: "$125.00" } }] },
          { heading: "Winter nightly rates", rows: [{ label: "Adult", audience: "Non-member", fee: { amountCents: 6000, label: "$60.00" } }] },
        ]}
      />,
    );
    expect(html).toContain("Full");
    expect(html).toContain("$125.00");
    expect(html).toContain("Non-member");
    expect(html).toContain("$60.00");
  });

  it("renders safe empty states for empty booking and cancellation policies", () => {
    const booking = renderToStaticMarkup(<BookingPolicyToken policy={{ lodge: null, hold: null, periods: [], minimumStays: [], groupDiscount: null }} />);
    const cancellation = renderToStaticMarkup(<CancellationPolicyToken policy={{ lodge: null, tiers: [], periods: [] }} />);
    expect(booking).toContain("No public information is currently available.");
    expect(cancellation).toContain("No public information is currently available.");
  });
});
