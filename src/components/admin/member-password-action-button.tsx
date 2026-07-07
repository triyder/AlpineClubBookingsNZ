"use client"

import { formatDistanceToNow } from "date-fns"
import { Button } from "@/components/ui/button"
import {
  getMemberPasswordActionKind,
  type MemberPasswordActionState,
} from "@/lib/member-login-stage"

// The pure derivation now lives in a non-client lib module (src/lib/member-login-stage.ts)
// so the members list Access column, the list filter, and this button all share
// one source of truth. Re-exported here so existing imports keep working.
export {
  getMemberPasswordActionKind,
  type MemberPasswordActionState,
}

function getMemberPasswordActionLabel(member: MemberPasswordActionState) {
  const kind = getMemberPasswordActionKind(member)
  if (kind === "reset-password") return "Reset Password"
  if (kind === "resend-invite") return "Resend Invite"
  if (kind === "invite") return "Invite"
  return null
}

function formatPendingInviteExpiry(expiresAt: string | Date) {
  return formatDistanceToNow(new Date(expiresAt), { addSuffix: true })
}

function getMemberPasswordActionTooltip(member: MemberPasswordActionState) {
  if (getMemberPasswordActionKind(member) !== "resend-invite" || !member.pendingInviteExpiresAt) {
    return undefined
  }

  return `Sent invite expires ${formatPendingInviteExpiry(member.pendingInviteExpiresAt)} - click to send a fresh 7-day link.`
}

interface MemberPasswordActionButtonProps {
  member: MemberPasswordActionState
  onClick: () => void
}

export function MemberPasswordActionButton({
  member,
  onClick,
}: MemberPasswordActionButtonProps) {
  const label = getMemberPasswordActionLabel(member)
  if (!label) return null

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      title={getMemberPasswordActionTooltip(member)}
    >
      {label}
    </Button>
  )
}
