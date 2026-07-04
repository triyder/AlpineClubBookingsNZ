"use client";

import { useCallback, useMemo, type RefObject } from "react";

type ElementRef = RefObject<HTMLElement | null>;
type ScrollContainerTarget = HTMLElement | ElementRef | null | undefined;
type ScrollErrorTarget = HTMLElement | ElementRef | string | null | undefined;

const FEEDBACK_SCROLL_MARGIN_TOP = "5rem";

function isHTMLElement(value: unknown): value is HTMLElement {
  return typeof HTMLElement !== "undefined" && value instanceof HTMLElement;
}

function resolveElement(target: ScrollContainerTarget): HTMLElement | null {
  if (!target) return null;
  if (isHTMLElement(target)) return target;
  return target.current;
}

function resolveFeedbackElement(target: ScrollErrorTarget): HTMLElement | null {
  if (!target) return null;
  if (typeof target === "string") {
    const element = document.querySelector(target);
    return isHTMLElement(element) ? element : null;
  }
  return resolveElement(target);
}

function hasScrollableOverflow(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  return [style.overflowY, style.overflow].some((value) =>
    ["auto", "scroll", "overlay"].includes(value),
  );
}

// test seam
export function getNearestScrollContainer(
  element: HTMLElement | null,
): HTMLElement | null {
  let current: HTMLElement | null = element;

  while (current) {
    if (hasScrollableOverflow(current)) return current;
    current = current.parentElement;
  }

  return null;
}

function resolveScrollContainer(
  target: ScrollContainerTarget,
): HTMLElement | null {
  const element = resolveElement(target);
  if (!element) return null;
  return getNearestScrollContainer(element);
}

// test seam
export function scrollToTop(containerRef: ScrollContainerTarget) {
  const container = resolveScrollContainer(containerRef);
  if (typeof container?.scrollTo === "function") {
    container.scrollTo({ top: 0, behavior: "smooth" });
  }
}

// test seam
export function scrollToError(errorRefOrSelector: ScrollErrorTarget) {
  const errorElement = resolveFeedbackElement(errorRefOrSelector);
  if (!errorElement) return;

  if (!errorElement.style.scrollMarginTop) {
    errorElement.style.scrollMarginTop = FEEDBACK_SCROLL_MARGIN_TOP;
  }
  if (!errorElement.hasAttribute("tabindex")) {
    errorElement.setAttribute("tabindex", "-1");
  }

  errorElement.focus({ preventScroll: true });
  if (typeof errorElement.scrollIntoView === "function") {
    errorElement.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

export function useScrollToFeedback() {
  const scrollTop = useCallback((containerRef: ScrollContainerTarget) => {
    scrollToTop(containerRef);
  }, []);
  const scrollError = useCallback((errorRefOrSelector: ScrollErrorTarget) => {
    scrollToError(errorRefOrSelector);
  }, []);

  return useMemo(
    () => ({
      scrollToTop: scrollTop,
      scrollToError: scrollError,
    }),
    [scrollError, scrollTop],
  );
}
