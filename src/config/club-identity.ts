/**
 * Bootstrap layer — the boot-critical club identity values that must resolve
 * SYNCHRONOUSLY at module import, before any database read is possible (epic
 * #1943, children C1/C6).
 *
 * The five "collapsing" identity fields — `publicUrl`, `supportEmail`,
 * `contactEmail`, `emailFromName`, and `socialLinks` — are, as of child C6
 * (#1985), resolved here from the **bootstrap layer only**, NEVER from
 * `config/club.json` (`clubConfig`):
 *   - the app origin comes from the `NEXTAUTH_URL` bootstrap env var, falling
 *     back to `SAFE_DEFAULT_CONFIG.publicUrl`;
 *   - the emails / from-name / social links fall back to `SAFE_DEFAULT_CONFIG`.
 * These synchronous exports are the intentional bootstrap defaults that seed the
 * `clubIdentity` object's non-admin-editable fields. Every ASYNC-context reader
 * of these fields resolves DB-first instead: outbound email identity via
 * `EmailMessageSetting` (`email-message-settings.ts`, applied at send time),
 * the public contact address via `loadEmailMessageSettings().contactEmail`, and
 * CMS URL/facebook tokens via the resolved `getClubIdentity()` identity. So
 * `config/club.json` is never read at runtime for the five collapsing fields;
 * it survives only as the seed + self-heal source (persisted into the DB at
 * boot) and, for the email search keys, inside the `email-message-settings.ts`
 * bootstrap resolver.
 *
 * `SAFE_DEFAULT_CONFIG.publicUrl` is guaranteed to be a valid absolute http(s)
 * URL (enforced by `clubConfigSchema`, pinned by `safe-default-config.test.ts`),
 * and `resolveBootstrapPublicUrl()` only accepts a valid http(s) `NEXTAUTH_URL`,
 * so `new URL(...)` below can never throw at import.
 *
 * `clubConfig` is still read for the E3-managed identity fields (name, short
 * name, hut-leader label, travel note) — those have their own DB-first/fallback
 * contracts and are out of C6's scope.
 */
import { clubConfig, SAFE_DEFAULT_CONFIG } from "@/config/club";
import type { ClubIdentity } from "@/config/club-identity-types";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";

/**
 * Bootstrap app origin for the identity layer: the `NEXTAUTH_URL` env var when
 * it is a valid absolute http(s) URL, else `SAFE_DEFAULT_CONFIG.publicUrl`
 * (never `config/club.json`). Mirrors `getAppBaseUrl()` (src/lib/app-url.ts) but
 * pins the fallback to the safe default's public URL rather than localhost, so
 * `publicHost` stays a real host for `clubDomainEmail`. Guaranteed to return a
 * valid absolute http(s) URL, so callers can `new URL()` it without guarding.
 */
function resolveBootstrapPublicUrl(): string {
  const candidate = process.env.NEXTAUTH_URL?.trim();
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin;
      }
    } catch {
      // fall through to the safe default
    }
  }
  return SAFE_DEFAULT_CONFIG.publicUrl;
}

export const CLUB_NAME = clubConfig.name;
const CLUB_SHORT_NAME = clubConfig.shortName ?? clubConfig.name;
// The five collapsing fields (C6 #1985): bootstrap-derived, never club.json.
export const CLUB_SUPPORT_EMAIL = SAFE_DEFAULT_CONFIG.supportEmail;
export const CLUB_CONTACT_EMAIL =
  SAFE_DEFAULT_CONFIG.contactEmail ?? SAFE_DEFAULT_CONFIG.supportEmail;
export const CLUB_PUBLIC_URL = resolveBootstrapPublicUrl();
export const CLUB_EMAIL_FROM_NAME = SAFE_DEFAULT_CONFIG.emailFromName;
const CLUB_SOCIAL_LINKS = SAFE_DEFAULT_CONFIG.socialLinks ?? {};
export const CLUB_LODGE_TRAVEL_NOTE =
  clubConfig.lodgeTravelNote ?? "Please allow adequate travel time.";
export const CLUB_HUT_LEADER_LABEL = clubConfig.hutLeaderLabel ?? "Hut Leader";
export const CLUB_BOOKINGS_NAME = `${clubConfig.name} - Bookings`;
// CLUB_LODGE_NAME was retired here (E3 #1929): the lodge display name is now
// DB-first (the default Lodge.name, resolved via club-identity-settings.ts).
// The `lodgeName` field on the clubIdentity object below stays the config-
// derived fallback used only when no Lodge row resolves. Email subject builders
// that need the STABLE config lodge-name search key import EMAIL_DEFAULT_LODGE_NAME
// from email-message-settings.ts instead.
const CLUB_LODGE_NAME_FALLBACK = `${clubConfig.name} Lodge`;
const CLUB_PUBLIC_HOST = new URL(CLUB_PUBLIC_URL).host;
const CLUB_EMAIL_DOMAIN = CLUB_PUBLIC_HOST.replace(/^www\./, "");

export const clubIdentity: ClubIdentity = {
  name: CLUB_NAME,
  shortName: CLUB_SHORT_NAME,
  supportEmail: CLUB_SUPPORT_EMAIL,
  contactEmail: CLUB_CONTACT_EMAIL,
  publicUrl: CLUB_PUBLIC_URL,
  emailFromName: CLUB_EMAIL_FROM_NAME,
  lodgeTravelNote: CLUB_LODGE_TRAVEL_NOTE,
  hutLeaderLabel: CLUB_HUT_LEADER_LABEL,
  socialLinks: CLUB_SOCIAL_LINKS,
  bookingsName: CLUB_BOOKINGS_NAME,
  lodgeName: CLUB_LODGE_NAME_FALLBACK,
  publicHost: CLUB_PUBLIC_HOST,
  lodgeCapacity: FALLBACK_LODGE_CAPACITY,
};

export function clubDomainEmail(localPart: string): string {
  return `${localPart}@${CLUB_EMAIL_DOMAIN}`;
}
