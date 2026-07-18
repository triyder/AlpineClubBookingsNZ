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

// The active TTL is resolved at the call site from the club's configured
// `LoginSecuritySetting.magicLinkTtlMinutes` (#2033) via
// `loadLoginSecuritySettings()`, re-clamped through `clampMagicLinkTtlMinutes`.
// That loader is prisma-backed and must stay out of this module so the
// admin card (a client component) can import the constants above without
// pulling prisma into the browser bundle.
