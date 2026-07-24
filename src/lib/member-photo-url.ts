/**
 * Client-safe serving-URL builder for member photos (epic #171, MP3+).
 *
 * Deliberately has NO `server-only` import (unlike `member-photo.ts`) so both
 * the member's own profile crop UI (MP3, a client component) and the committee
 * fan-out (MP5) can build a stable `<img src>` from a member id.
 *
 * The URL always resolves to the scoped `/api/members/[id]/photo` endpoint —
 * never the public `/api/images/[id]` content path (ADR-001, owner decision 3),
 * so authorisation is enforced per target member. Keeping this in one place
 * makes that invariant testable.
 */
export function memberPhotoServingUrl(
  memberId: string,
  version?: string | number | null,
): string {
  const base = `/api/members/${encodeURIComponent(memberId)}/photo`;
  if (version === undefined || version === null || version === "") {
    return base;
  }
  // Cache-busting query so a freshly replaced photo is re-fetched even while the
  // committee-public response carries a short public cache + ETag.
  return `${base}?v=${encodeURIComponent(String(version))}`;
}
