/**
 * Club-internal placeholder email for walk-in booking owners (issue #1935, E9).
 *
 * `Member.email` is non-nullable, but a phone/walk-in non-member booking owner
 * often has no email address. Instead of a schema change we store a recognisable
 * placeholder on the `.invalid` reserved TLD (RFC 2606 — never deliverable) so
 * that:
 *   - no outbound email is ever sent to that owner (see the guard in
 *     `sendEmail`, src/lib/email/core.ts),
 *   - the placeholder is never used for Xero contact email-matching and is never
 *     pushed to Xero as a real address (see the guards in xero-contacts.ts /
 *     xero-contact-sync.ts).
 *
 * This module is a dependency-free leaf (crypto only) so it can be imported from
 * the email core, the Xero contact layer, and the non-member-contact service
 * without introducing an import cycle.
 */
import { randomUUID } from "crypto";

/**
 * Reserved club-internal domain for walk-in placeholder addresses. `.invalid`
 * is guaranteed non-resolvable (RFC 2606), so a placeholder can never collide
 * with a real deliverable address.
 */
export const PLACEHOLDER_CONTACT_EMAIL_DOMAIN = "no-email.invalid";

/**
 * Mint a fresh, unique placeholder address for a walk-in contact. Uniqueness
 * keeps distinct walk-ins on distinct stored strings even though the partial
 * `Member_email_login_unique` index (canLogin = true only) never applies to
 * these non-login contacts.
 */
export function buildPlaceholderContactEmail(): string {
  return `walk-in-${randomUUID()}@${PLACEHOLDER_CONTACT_EMAIL_DOMAIN}`;
}

/**
 * True when the address is a club-internal walk-in placeholder rather than a
 * real address. Case/whitespace-insensitive; matches on the reserved domain.
 */
export function isPlaceholderContactEmail(
  email: string | null | undefined
): boolean {
  if (!email) return false;
  return email
    .trim()
    .toLowerCase()
    .endsWith(`@${PLACEHOLDER_CONTACT_EMAIL_DOMAIN}`);
}
