// JSON-serialised shapes of the partner-link API payloads (Dates arrive as
// ISO strings), shared by the member profile Partner card and the admin
// member-detail Partner card so the two clients cannot drift apart (#1754).
// Server-side source of truth: PartnerLinkView / PartnerLinkState in
// src/lib/member-partner-link.ts (this file must stay import-free so client
// components can use it without pulling in server-only code).

export interface SerializedPartnerLinkMember {
  id: string;
  firstName: string;
  lastName: string;
  canLogin: boolean;
}

export interface SerializedPartnerLinkView {
  id: string;
  status: string;
  partner: SerializedPartnerLinkMember;
  initiatedByMe: boolean;
  assignedByAdmin: boolean;
  confirmedAt: string | null;
  createdAt: string;
}

/** GET /api/admin/members/[id]/partner-link response body. */
export interface SerializedPartnerLinkState {
  confirmed: SerializedPartnerLinkView | null;
  pendingIncoming: SerializedPartnerLinkView[];
  pendingOutgoing: SerializedPartnerLinkView[];
}

/**
 * GET /api/members/partner-link response body: the link state plus the
 * member-only extras — one-step declaration candidates (present only when
 * the caller admins a family group with no-login adults) and the caller's
 * outstanding declared-partner invitation to an unregistered partner, which
 * they may cancel while it is unclaimed (#1754).
 */
export interface MemberPartnerLinkStateResponse extends SerializedPartnerLinkState {
  oneStepCandidates: SerializedPartnerLinkMember[];
  pendingPartnerInvite: {
    id: string;
    invitedEmail: string;
    expiresAt: string;
  } | null;
}
