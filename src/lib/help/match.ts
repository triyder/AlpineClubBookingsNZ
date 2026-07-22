import type { HelpPageContent, HelpPageEntry } from "./types";

/**
 * Client-safe corpus matcher, split out of `@/lib/help` (`index.ts`) so the
 * member and public help-widget wrappers can resolve a page entry WITHOUT
 * importing the admin/finance registry (`@/lib/contextual-help`). This module
 * imports only local *types*, so a wrapper that pairs it with `public-help.ts`
 * pulls no admin corpus into its client bundle (epic #2094 C2 bundle-split).
 *
 * The matching semantics are identical to the ones `index.ts` used before it
 * delegated here, so the C1 corpus tests keep passing byte-for-byte:
 *  - `"/x/*"` — matches `/x/<anything>` but NOT `/x` itself, scored just above a
 *    plain `/x` so a detail entry beats the list entry for the same base.
 *  - `"/x"` — longest-prefix: matches `/x` and any `/x/...` descendant.
 */

const NO_MATCH = -1;

/**
 * Strip the query/hash and any single trailing slash. A local copy of
 * `contextual-help.ts`'s `normalisePath` so this module stays free of that
 * (admin-corpus-bearing) import; pinned identical by the C1 corpus tests.
 */
export function normaliseHelpPath(pathname: string | null | undefined): string {
  if (!pathname) {
    return "/";
  }
  const withoutQuery = pathname.split(/[?#]/, 1)[0] || "/";
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery;
}

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

/**
 * Resolve the best-matching entry content for `pathname` (normalised
 * internally), falling back to `fallback` when nothing matches.
 */
export function matchHelpEntry(
  pathname: string | null | undefined,
  entries: HelpPageEntry[],
  fallback: HelpPageContent,
): HelpPageContent {
  const path = normaliseHelpPath(pathname);
  let best: HelpPageEntry | null = null;
  let bestScore = NO_MATCH;

  for (const candidate of entries) {
    const score = matchScore(path, candidate.path);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best?.content ?? fallback;
}
