/**
 * The legacy POSIX-rule timezone names, whose meaning the tz database changed
 * under the suites that use them (triyder/AlpineClubBookingsNZ#84,
 * thatskiff33/AlpineClubBookingsNZ#4303).
 *
 * Until tzdata 2026c `EST5EDT` and `PST8PDT` were links to `America/New_York`
 * and `America/Los_Angeles`, so `Intl` canonicalised them to a place and the
 * preservation rule in `src/lib/club-time-zone.ts` kept that place. tzdata
 * 2026d (shipped in Node 24.22.1) made them rule zones of their own again — US
 * federal rules, no place — so the runtime names them as themselves and the
 * preservation rule refuses them exactly as it refuses `Etc/GMT+5`, recording
 * nothing. Both are the designed answer. Which one applies is the runtime's
 * call, so a suite asks {@link runtimeLinksToAPlace} before asserting rather than
 * pinning the reading of whichever Node happens to run it; CI's test shards do
 * not all run the same Node build, so a pinned reading passes or fails by shard.
 *
 * These are test-only questions put to the runtime, not a second copy of the
 * production rule: `runtimeLinksToAPlace` selects the fixture branch, and the
 * assertions in each branch are what hold the rule to account.
 */

/** The two names every club-timezone suite used to pin to a place. */
export const LEGACY_POSIX_RULE_NAMES = ["EST5EDT", "PST8PDT"] as const;

/** What this runtime's tz database canonicalises `zone` to, or null if unknown. */
export function runtimeCanonicalName(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-NZ", { timeZone: zone }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

/** True when this runtime links `zone` to a place (a slash-separated location). */
export function runtimeLinksToAPlace(zone: string): boolean {
  return runtimeCanonicalName(zone)?.includes("/") ?? false;
}
