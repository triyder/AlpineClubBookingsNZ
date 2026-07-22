import {
  getContextualHelp,
  getContextualHelpPaths,
} from "@/lib/contextual-help";
import { matchHelpEntry } from "./match";
import { memberFallbackHelp, memberHelpEntries } from "./member-help";
import { publicFallbackHelp, publicHelpEntries } from "./public-help";
import type { HelpPageContent, HelpSurface } from "./types";

/**
 * Unified help lookup across all four surfaces. Admin and finance delegate to the
 * existing `@/lib/contextual-help` registry, so their longest-prefix semantics
 * and the exact content objects are preserved unchanged. Member and public use
 * the new corpora in this folder with a `/*`-aware matcher that distinguishes a
 * list page (`/bookings`) from a detail page (`/bookings/[id]`).
 *
 * This module (and everything it imports) is server/test-only by convention —
 * there is no "use client" anywhere under `src/lib/help/`.
 */

export function getHelpForPage(
  surface: HelpSurface,
  pathname: string,
): HelpPageContent {
  if (surface === "admin" || surface === "finance") {
    // Delegate so the returned object is the very same registry content object
    // (admin/finance parity), including the fallback.
    return getContextualHelp(pathname, surface);
  }

  // The `/*`-aware matcher lives in `./match` so the client help-widget wrappers
  // can reuse it without dragging the admin corpus into their bundle.
  if (surface === "member") {
    return matchHelpEntry(pathname, memberHelpEntries, memberFallbackHelp);
  }
  return matchHelpEntry(pathname, publicHelpEntries, publicFallbackHelp);
}

/** Test seam: the entry paths registered for a surface. */
export function getHelpPaths(surface: HelpSurface): string[] {
  if (surface === "admin" || surface === "finance") {
    return getContextualHelpPaths(surface);
  }
  const entries =
    surface === "member" ? memberHelpEntries : publicHelpEntries;
  return entries.map((candidate) => candidate.path);
}
