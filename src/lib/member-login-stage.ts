/**
 * Login-journey stage for an admin member row (issue #1444).
 *
 * The admin members list used to say the same thing twice — a "No Login" badge
 * in the Access column and a "Non-Login"/"Can Login" badge in a separate Login
 * column — while hiding where a login-enabled member sat in the invite journey.
 * This module is the single source of truth for that journey so the Access
 * column, the row action button, and the list filter can never disagree.
 *
 * The four stages map 1:1 onto {@link getMemberPasswordActionKind}:
 *   - no-login    → kind null            (canLogin off)
 *   - not-invited → "invite"             (login on, no invite/password yet)
 *   - invited     → "resend-invite"      (pending unexpired invite token)
 *   - can-login   → "reset-password"     (account setup complete)
 *
 * Kept in a non-"use client" module (unlike the action button that re-exports
 * it) so both server WHERE mirroring and plain unit tests can import it.
 */

export interface MemberPasswordActionState {
  canLogin: boolean
  hasCompletedAccountSetup: boolean
  pendingInviteExpiresAt: string | Date | null
}

export type MemberPasswordActionKind = "invite" | "resend-invite" | "reset-password"

export function getMemberPasswordActionKind(
  member: MemberPasswordActionState
): MemberPasswordActionKind | null {
  if (!member.canLogin) return null
  if (member.hasCompletedAccountSetup) return "reset-password"
  return member.pendingInviteExpiresAt ? "resend-invite" : "invite"
}

export type MemberLoginStage =
  | "no-login"
  | "not-invited"
  | "invited"
  | "can-login"

/** Display labels, declared in the order the filter select lists them. */
export const LOGIN_STAGE_LABELS: Record<MemberLoginStage, string> = {
  "no-login": "No login",
  "not-invited": "Not invited",
  invited: "Invited",
  "can-login": "Can log in",
}

/**
 * The `inviteStatus` query-param value that filters to each stage. The three
 * login-on values are the existing action kinds (kept for least churn); the
 * no-login value is new for #1444.
 */
export const LOGIN_STAGE_FILTER_VALUES: Record<MemberLoginStage, string> = {
  "no-login": "no-login",
  "not-invited": "invite",
  invited: "resend-invite",
  "can-login": "reset-password",
}

/**
 * The member's single current login-journey stage, derived from the same
 * {@link getMemberPasswordActionKind} the row action button uses so the column
 * and the button can never disagree.
 */
export function getMemberLoginStage(
  member: MemberPasswordActionState
): MemberLoginStage {
  const kind = getMemberPasswordActionKind(member)
  if (kind === null) return "no-login"
  if (kind === "invite") return "not-invited"
  if (kind === "resend-invite") return "invited"
  return "can-login"
}
