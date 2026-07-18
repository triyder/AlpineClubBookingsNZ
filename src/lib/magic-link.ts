// Email magic-link sign-in shared constants and TTL loader (#2034).
//
// Magic link is additive to password login: a member requests a single-use,
// short-lived email link that signs them in only if they are an existing
// active, verified, login-capable member. The token itself is minted and
// hashed by src/lib/action-tokens.ts (the same primitive password reset uses).

/** Code default when no configured value is available. Owner decision (#2030). */
export const DEFAULT_MAGIC_LINK_TTL_MINUTES = 15;

/** Configurable range surfaced on the Login & Security page (#2033). */
export const MAGIC_LINK_TTL_MIN_MINUTES = 5;
export const MAGIC_LINK_TTL_MAX_MINUTES = 60;

/** Clamp a candidate TTL (minutes) into the supported range. */
export function clampMagicLinkTtlMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_MAGIC_LINK_TTL_MINUTES;
  return Math.min(
    MAGIC_LINK_TTL_MAX_MINUTES,
    Math.max(MAGIC_LINK_TTL_MIN_MINUTES, Math.round(minutes)),
  );
}

export function magicLinkTtlMs(minutes: number): number {
  return minutes * 60 * 1000;
}

/**
 * Resolve the active magic-link TTL in minutes.
 *
 * TODO(#2033): the Login & Security child lands `LoginSecuritySetting`
 * (with `magicLinkTtlMinutes`) and a `loadLoginSecuritySettings()` loader.
 * When this branch rebases onto that merge, replace the body below with:
 *
 *   const settings = await loadLoginSecuritySettings();
 *   return clampMagicLinkTtlMinutes(settings.magicLinkTtlMinutes);
 *
 * That model does NOT exist in this branch's schema (it is owned by #2033), so
 * until then this returns the code default. Keeping the function async now means
 * the one-line swap at rebase time does not ripple through the callers.
 */
export async function loadMagicLinkTtlMinutes(): Promise<number> {
  return DEFAULT_MAGIC_LINK_TTL_MINUTES;
}
