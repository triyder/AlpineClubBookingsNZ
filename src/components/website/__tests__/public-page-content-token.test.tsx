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
          collapsedColumns: true,
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
    // A column with no rate for a row renders an em dash. This says nothing
    // about $0.00, which is a legitimate price — see the zero-vs-absent test.
    expect(html).toContain("—");
    // A multi-name heading reads as a rendering glitch without an explanation,
    // and it is shown only when a column actually collapses.
    expect(html).toContain("Types sharing a column are charged the same nightly rate.");
    // NOTE: class-presence smoke check only — renderToStaticMarkup has no
    // layout engine and no viewport, so this cannot assert overflow behaviour.
    // The binding mobile/a11y contract for this surface lives in
    // src/lib/__tests__/final-a11y-presentation-contract.test.ts.
    expect(html).toContain("overflow-x-auto");
  });

  it("distinguishes a free $0.00 rate from an absent one in the same row (#2129)", () => {
    const html = renderToStaticMarkup(
      <FeeTableToken
        tables={[{
          heading: "River Lodge — Winter nightly rates",
          rowHeading: "Age",
          columns: ["Full Member", "Non-member"],
          collapsedColumns: false,
          rows: [
            // Free for members, not offered at all to non-members.
            { label: "Infant", cells: [{ amountCents: 0, label: "$0.00" }, null] },
          ],
        }]}
      />,
    );
    // Zero is a price and must render as one. `cells` holds PublicMoney
    // OBJECTS, never bare numbers — flattening them would make 0 falsy and
    // silently turn a free infant night into "no rate".
    expect(html).toContain("$0.00");
    expect(html).toContain("—");
    // ...and the absent cell is spoken, since NVDA/JAWS skip a bare em dash.
    expect(html).toContain("No rate");
  });

  it("keeps the hut-fee scroll region reachable and every table named (#2129)", () => {
    const html = renderToStaticMarkup(
      <FeeTableToken
        idPrefix="hut-fees-rates-0"
        tables={[
          { heading: "River Lodge — Winter", rowHeading: "Age", columns: ["Full Member"], collapsedColumns: false, rows: [{ label: "Adult", cells: [{ amountCents: 4000, label: "$40.00" }] }] },
          { heading: "River Lodge — Summer", rowHeading: "Age", columns: ["Full Member"], collapsedColumns: false, rows: [{ label: "Adult", cells: [{ amountCents: 3000, label: "$30.00" }] }] },
        ]}
      />,
    );
    // WCAG 2.1.1: the horizontal scroller must be focusable and named, or a
    // keyboard-only visitor cannot reach columns clipped off-screen.
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    // Each table is named from its own heading, so a screen-reader user does
    // not hear several indistinguishable "table, N columns, M rows".
    // Three per table — the section, the scroll region, and the table itself —
    // all pointing at that table's own heading id.
    expect(html.match(/aria-labelledby=/g) ?? []).toHaveLength(6);
    expect(html).toContain('aria-labelledby="hut-fees-rates-0-0-heading"');
    expect(html).toContain('aria-labelledby="hut-fees-rates-0-1-heading"');
    // Ids are namespaced per embed so two hut-fee blocks on one page cannot
    // collide.
    expect(html).toContain('id="hut-fees-rates-0-0-heading"');
    // No explanation line when nothing collapsed.
    expect(html).not.toContain("Types sharing a column");
  });

  it("escapes hostile persisted display strings in the hut-fee table renderer (#2129)", () => {
    const html = renderToStaticMarkup(
      <FeeTableToken
        tables={[{
          heading: '<script>alert("h")</script>',
          rowHeading: "Age",
          columns: ['<img src=x onerror="alert(1)">'],
          collapsedColumns: false,
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
      <FeeTableToken tables={[{ heading: "Winter", rowHeading: "Age", columns: [], collapsedColumns: false, rows: [] }]} />,
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
