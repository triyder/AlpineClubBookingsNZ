// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { OccupancyMeter } from "@/components/ui/occupancy-meter";

function progressbar(container: HTMLElement) {
  const pb = container.querySelector('[role="progressbar"]');
  if (!pb) throw new Error("no progressbar rendered");
  return pb;
}

describe("OccupancyMeter", () => {
  it("partial fill: aria attributes, count text, accent fill, not full", () => {
    const { container } = render(<OccupancyMeter filled={12} capacity={30} />);
    const pb = progressbar(container);
    expect(pb.getAttribute("aria-valuenow")).toBe("12");
    expect(pb.getAttribute("aria-valuemin")).toBe("0");
    expect(pb.getAttribute("aria-valuemax")).toBe("30");
    expect(pb.getAttribute("aria-label")).toBe("12 of 30 bunks filled");
    expect(container.textContent).toContain("12 / 30");
    expect(container.textContent).not.toContain("Full");
    const fill = pb.querySelector("div");
    expect(fill?.className).toContain("bg-brand-gold");
    expect(fill?.getAttribute("style")).toContain("width: 40%");
  });

  it("full: Full label, safety-orange fill, aria announces full", () => {
    const { container } = render(<OccupancyMeter filled={30} capacity={30} />);
    const pb = progressbar(container);
    expect(pb.getAttribute("aria-valuenow")).toBe("30");
    expect(pb.getAttribute("aria-label")).toBe("30 of 30 bunks filled, full");
    expect(container.textContent).toContain("Full");
    const fill = pb.querySelector("div");
    expect(fill?.className).toContain("bg-brand-safety");
    expect(fill?.className).not.toContain("bg-brand-gold");
    expect(fill?.getAttribute("style")).toContain("width: 100%");
    expect(container.querySelector(".text-danger")?.textContent).toContain("Full");
  });

  it("over-book: aria + fill clamp to capacity, raw count still shown, full", () => {
    const { container } = render(<OccupancyMeter filled={31} capacity={30} />);
    const pb = progressbar(container);
    expect(pb.getAttribute("aria-valuenow")).toBe("30");
    expect(pb.getAttribute("aria-valuemax")).toBe("30");
    expect(container.textContent).toContain("31 / 30");
    expect(container.textContent).toContain("Full");
    const fill = pb.querySelector("div");
    expect(fill?.getAttribute("style")).toContain("width: 100%");
  });

  it("zero capacity: no crash, empty fill, not marked full", () => {
    const { container } = render(<OccupancyMeter filled={0} capacity={0} />);
    const pb = progressbar(container);
    expect(pb.getAttribute("aria-valuenow")).toBe("0");
    expect(pb.getAttribute("aria-valuemax")).toBe("0");
    expect(container.textContent).not.toContain("Full");
    const fill = pb.querySelector("div");
    expect(fill?.getAttribute("style")).toContain("width: 0%");
  });

  it("negative / fractional inputs are floored and clamped to a valid range", () => {
    const { container } = render(<OccupancyMeter filled={-4} capacity={30} />);
    const pb = progressbar(container);
    expect(pb.getAttribute("aria-valuenow")).toBe("0");
    expect(container.textContent).toContain("0 / 30");
  });

  it("label caption is shown and folded into the aria-label", () => {
    const { container } = render(
      <OccupancyMeter filled={5} capacity={10} label="Main Bunkroom" />,
    );
    const pb = progressbar(container);
    expect(pb.getAttribute("aria-label")).toBe("Main Bunkroom: 5 of 10 bunks filled");
    expect(container.textContent).toContain("Main Bunkroom");
  });

  it("width transition is CSS-based so the reduced-motion guard covers it", () => {
    const { container } = render(<OccupancyMeter filled={5} capacity={10} />);
    const fill = progressbar(container).querySelector("div");
    expect(fill?.className).toContain("transition-[width]");
  });

  it("size=sm applies a thinner track", () => {
    const { container } = render(<OccupancyMeter filled={5} capacity={10} size="sm" />);
    expect(progressbar(container).className).toContain("h-1.5");
  });
});
