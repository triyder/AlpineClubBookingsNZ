import {
  getContextualHelp,
  getContextualHelpPaths,
  normalisePath,
} from "@/lib/contextual-help";
import { memberFallbackHelp, memberHelpEntries } from "./member-help";
import { publicFallbackHelp, publicHelpEntries } from "./public-help";
import type { HelpPageContent, HelpPageEntry, HelpSurface } from "./types";

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

const NO_MATCH = -1;

/**
 * Score how well `entryPath` matches `pathname`. Higher wins; NO_MATCH means no
 * match. Two forms are supported:
 *  - `"/x/*"` — matches `/x/<anything>` but NOT `/x` itself. Scored just above a
 *    plain `/x` so a detail entry beats the list entry for the same base.
 *  - `"/x"` — longest-prefix: matches `/x` and any `/x/...` descendant.
 */
function matchScore(pathname: string, entryPath: string): number {
  if (entryPath.endsWith("/*")) {
    const base = entryPath.slice(0, -2);
    if (pathname === base) {
      return NO_MATCH;
    }
    if (pathname.startsWith(`${base}/`)) {
      return base.length + 0.5;
    }
    return NO_MATCH;
  }

  if (pathname === entryPath || pathname.startsWith(`${entryPath}/`)) {
    return entryPath.length;
  }
  return NO_MATCH;
}

function matchEntry(
  pathname: string,
  entries: HelpPageEntry[],
  fallback: HelpPageContent,
): HelpPageContent {
  let best: HelpPageEntry | null = null;
  let bestScore = NO_MATCH;

  for (const candidate of entries) {
    const score = matchScore(pathname, candidate.path);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best?.content ?? fallback;
}

export function getHelpForPage(
  surface: HelpSurface,
  pathname: string,
): HelpPageContent {
  if (surface === "admin" || surface === "finance") {
    // Delegate so the returned object is the very same registry content object
    // (admin/finance parity), including the fallback.
    return getContextualHelp(pathname, surface);
  }

  const path = normalisePath(pathname);
  if (surface === "member") {
    return matchEntry(path, memberHelpEntries, memberFallbackHelp);
  }
  return matchEntry(path, publicHelpEntries, publicFallbackHelp);
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
