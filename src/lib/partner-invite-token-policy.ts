import "server-only";

import { issueActionToken } from "@/lib/action-tokens";

// A partner who has no account must first complete the club's nominator-based
// membership process before they can claim their invite, which is far slower
// than a single nomination confirmation. A 30-day TTL (vs the 7-day nomination
// TTL) keeps the invite alive across that process. An admin can revoke an
// outstanding invite early; there is no automatic re-invite — a fresh
// invitation means a new create-group (or invite) flow. See
// docs/DOMAIN_INVARIANTS.md.
export const PARTNER_INVITE_TOKEN_TTL_DAYS = 30;

const PARTNER_INVITE_TOKEN_TTL_MS =
  PARTNER_INVITE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export function getPartnerInviteTokenExpiryDate(now = new Date()) {
  return new Date(now.getTime() + PARTNER_INVITE_TOKEN_TTL_MS);
}

export function normalizeInvitedEmail(email: string) {
  return email.toLowerCase().trim();
}

/**
 * Build the persisted fields for a new partner-invite token. The caller stores
 * the returned `data` (inside its own transaction) and emails the returned raw
 * `token` exactly once — only its sha256 hash is persisted.
 */
export function buildPartnerInviteTokenData(params: {
  familyGroupId: string;
  invitedEmail: string;
  createdById: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const { token, tokenHash } = issueActionToken();
  return {
    token,
    data: {
      tokenHash,
      familyGroupId: params.familyGroupId,
      invitedEmail: normalizeInvitedEmail(params.invitedEmail),
      createdById: params.createdById,
      expiresAt: getPartnerInviteTokenExpiryDate(now),
      reminderCount: 0,
      lastSentAt: now,
    },
  };
}
