// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNearestScrollContainer,
  scrollToError,
  scrollToTop,
} from "@/hooks/use-scroll-to-feedback";

describe("use-scroll-to-feedback", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("selects the nearest scrollable ancestor instead of the window", () => {
    const outer = document.createElement("main");
    outer.style.overflowY = "auto";
    const inner = document.createElement("section");
    const feedback = document.createElement("div");
    inner.append(feedback);
    outer.append(inner);
    document.body.append(outer);

    const scrollTo = vi.fn();
    outer.scrollTo = scrollTo;

    expect(getNearestScrollContainer(feedback)).toBe(outer);

    scrollToTop({ current: feedback });

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("focuses and scrolls the feedback element with sticky-nav spacing", () => {
    const feedback = document.createElement("div");
    feedback.id = "feedback";
    document.body.append(feedback);

    const focus = vi.fn();
    const scrollIntoView = vi.fn();
    feedback.focus = focus;
    feedback.scrollIntoView = scrollIntoView;

    scrollToError("#feedback");

    expect(feedback.getAttribute("tabindex")).toBe("-1");
    expect(feedback.style.scrollMarginTop).toBe("5rem");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });
});
