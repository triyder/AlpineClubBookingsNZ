import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BookingPolicyToken,
  CancellationPolicyToken,
  FeeGroupsToken,
  FeeTableToken,
} from "@/components/website/public-page-content-token";

describe("public PageContent token rendering", () => {
  it("escapes hostile persisted display strings in the grouped fee renderer", () => {
    const html = renderToStaticMarkup(
      <FeeGroupsToken
        groups={[{
          heading: '<script>alert("h")</script>',
          rows: [{ label: '<img src=x onerror="alert(1)">', fee: { amountCents: 1000, label: "$10.00" } }],
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

  it("renders one section per populated group", () => {
    const html = renderToStaticMarkup(
      <FeeGroupsToken
        groups={[
          { heading: "Full", rows: [{ label: "Adult", fee: { amountCents: 12500, label: "$125.00" } }] },
          { heading: "Associate", rows: [{ label: "Adult", fee: { amountCents: 6000, label: "$60.00" } }] },
        ]}
      />,
    );
    expect(html).toContain("Full");
    expect(html).toContain("$125.00");
    expect(html).toContain("Associate");
    expect(html).toContain("$60.00");
  });

  it("renders hut fees as a real table of age tiers x membership-type columns (#2129)", () => {
    const html = renderToStaticMarkup(
      <FeeTableToken
        tables={[{
          heading: "River Lodge — Winter nightly rates",
          rowHeading: "Age",
          columns: ["Full Member, Life", "Non-member"],
          rows: [
            { label: "Adult", cells: [{ amountCents: 4000, label: "$40.00" }, { amountCents: 6000, label: "$60.00" }] },
            { label: "All ages", cells: [null, { amountCents: 9000, label: "$90.00" }] },
          ],
        }]}
      />,
    );
    expect(html).toContain("<table");
    expect(html).toContain("River Lodge — Winter nightly rates");
    expect(html).toContain("Full Member, Life");
    expect(html).toContain("$40.00");
    expect(html).toContain("$60.00");
    // A column with no rate for a row renders an em dash, never a zero.
    expect(html).toContain("—");
    expect(html).not.toContain("$0.00");
    // Mobile treatment: the table scrolls inside its own container so the page
    // body never scrolls horizontally.
    expect(html).toContain("overflow-x-auto");
  });

  it("escapes hostile persisted display strings in the hut-fee table renderer (#2129)", () => {
    const html = renderToStaticMarkup(
      <FeeTableToken
        tables={[{
          heading: '<script>alert("h")</script>',
          rowHeading: "Age",
          columns: ['<img src=x onerror="alert(1)">'],
          rows: [{ label: "<b>Adult</b>", cells: [{ amountCents: 1000, label: "$10.00" }] }],
        }]}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>Adult");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("$10.00");
  });

  it("renders the shared empty state for an empty or column-less hut-fee table (#2129)", () => {
    const noTables = renderToStaticMarkup(<FeeTableToken tables={[]} />);
    const noColumns = renderToStaticMarkup(
      <FeeTableToken tables={[{ heading: "Winter", rowHeading: "Age", columns: [], rows: [] }]} />,
    );
    expect(noTables).toContain("No public information is currently available.");
    expect(noColumns).toContain("No public information is currently available.");
  });

  it("renders safe empty states for empty booking and cancellation policies", () => {
    const booking = renderToStaticMarkup(<BookingPolicyToken policy={{ lodge: null, hold: null, periods: [], minimumStays: [], groupDiscount: null }} />);
    const cancellation = renderToStaticMarkup(<CancellationPolicyToken policy={{ lodge: null, tiers: [], periods: [] }} />);
    expect(booking).toContain("No public information is currently available.");
    expect(cancellation).toContain("No public information is currently available.");
  });
});
