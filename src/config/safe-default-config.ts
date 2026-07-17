import type { ClubConfig } from "./schema";

/**
 * Recursively freeze the safe default so no future consumer can mutate the
 * canonical constant in place (the loader returns it by reference on every
 * fallback branch, so a mutation would silently corrupt the single source of
 * truth for the "unconfigured club" state).
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The single canonical hard-coded club configuration used as the last-resort
 * boot-safe default (epic #1943, child C1).
 *
 * This is the ONE source of truth for the "unconfigured club" identity. Both the
 * runtime config loader (`src/config/club.ts`) and the setup wizard/CLI
 * (`scripts/setup.ts`) reference this constant so no second copy of the default
 * can drift out of sync.
 *
 * Invariants (asserted by `safe-default-config.test.ts`):
 * - It MUST satisfy `clubConfigSchema` (so it is a drop-in for a valid file).
 * - `publicUrl` MUST be a valid absolute http(s) URL, because
 *   `src/config/club-identity.ts` runs `new URL(CLUB_PUBLIC_URL).host` at module
 *   import, and `CLUB_PUBLIC_URL` falls back to `SAFE_DEFAULT_CONFIG.publicUrl`
 *   when `NEXTAUTH_URL` is absent (C6 #1985) — a blank/invalid value would crash
 *   boot. Keep it a real absolute URL when editing this constant.
 *
 * Defined here in its own side-effect-free module (rather than inline in
 * `club.ts`) so that importing the default never triggers `club.ts`'s eager
 * `clubConfig` singleton load; `club.ts` re-exports it as the public surface.
 */
export const SAFE_DEFAULT_CONFIG: ClubConfig = deepFreeze({
  name: "Example Mountain Club",
  shortName: "EMC",
  supportEmail: "support@example.org",
  contactEmail: "bookings@example.org",
  publicUrl: "https://example.org",
  emailFromName: "Example Mountain Club - Online Booking System",
  lodgeTravelNote: "Please allow adequate travel time.",
  beds: [{ id: "lodge", name: "Main Lodge", capacity: 20, type: "dormitory" }],
  ageTiers: [
    {
      id: "INFANT",
      label: "Infant (under 5)",
      minAge: 0,
      maxAge: 4,
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      nightlyRates: {
        winter: { memberCents: 0, nonMemberCents: 0 },
        summer: { memberCents: 0, nonMemberCents: 0 },
      },
    },
    {
      id: "CHILD",
      label: "Child (5-9)",
      minAge: 5,
      maxAge: 9,
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      nightlyRates: {
        winter: { memberCents: 1500, nonMemberCents: 2500 },
        summer: { memberCents: 1000, nonMemberCents: 2000 },
      },
    },
    {
      id: "YOUTH",
      label: "Youth (10-17)",
      minAge: 10,
      maxAge: 17,
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: false,
      nightlyRates: {
        winter: { memberCents: 3000, nonMemberCents: 4500 },
        summer: { memberCents: 2500, nonMemberCents: 3500 },
      },
    },
    {
      id: "ADULT",
      label: "Adult (18+)",
      minAge: 18,
      maxAge: null,
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: false,
      nightlyRates: {
        winter: { memberCents: 4500, nonMemberCents: 6500 },
        summer: { memberCents: 3500, nonMemberCents: 5000 },
      },
    },
  ],
});
