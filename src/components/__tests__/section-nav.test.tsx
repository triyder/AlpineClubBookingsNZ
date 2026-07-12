// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { SectionNav } from "@/components/section-nav";

const SECTIONS = [
  { id: "alpha", label: "Alpha" },
  { id: "bravo", label: "Bravo" },
  { id: "ghost", label: "Ghost" },
];

describe("SectionNav", () => {
  it("renders keyboard-focusable anchor links for the sections present in the DOM", async () => {
    render(
      <>
        <SectionNav sections={SECTIONS} />
        <div id="alpha">Alpha section</div>
        <div id="bravo">Bravo section</div>
      </>,
    );

    // "ghost" has no matching element, so it is pruned after mount.
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Ghost" })).toBeNull();
    });

    // Each present section appears in both the mobile disclosure and the
    // desktop rail — real <a href="#id"> anchors (implicit role=link), which
    // are natively keyboard-focusable.
    const alpha = screen.getAllByRole("link", { name: "Alpha" });
    expect(alpha.length).toBeGreaterThanOrEqual(1);
    for (const link of alpha) {
      expect(link.getAttribute("href")).toBe("#alpha");
    }
    expect(screen.getAllByRole("link", { name: "Bravo" }).length).toBeGreaterThanOrEqual(1);
  });

  it("exposes a labelled nav landmark and a native details disclosure for mobile", () => {
    const { container } = render(
      <>
        <SectionNav sections={SECTIONS} title="On this page" />
        <div id="alpha">Alpha section</div>
        <div id="bravo">Bravo section</div>
      </>,
    );

    expect(
      container.querySelector('nav[aria-label="On this page"]'),
    ).not.toBeNull();
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")).not.toBeNull();
  });

  it("renders nothing when fewer than two sections are present", async () => {
    const { container } = render(
      <>
        <SectionNav sections={[{ id: "only", label: "Only" }]} />
        <div id="only">Only section</div>
      </>,
    );

    await waitFor(() => {
      expect(container.querySelector("nav")).toBeNull();
    });
  });
});
