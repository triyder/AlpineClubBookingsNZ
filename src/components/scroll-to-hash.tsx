"use client";

import { useEffect } from "react";

/**
 * Scrolls to the URL fragment once the real page content has mounted.
 *
 * Next's built-in hash scrolling fires when navigation commits, which can be
 * while a route loading.tsx skeleton is still showing — the target id doesn't
 * exist yet and the scroll is silently skipped. Rendering this component
 * inside the real page guarantees the target is in the DOM when it runs.
 */
export function ScrollToHash() {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    document.getElementById(id)?.scrollIntoView();
  }, []);

  return null;
}
