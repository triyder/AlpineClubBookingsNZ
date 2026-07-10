import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import {
  listOutstandingPartnerInviteTokens,
  revokePartnerInviteToken,
} from "@/lib/partner-invite-token";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

/**
 * GET /api/admin/family-groups/partner-invites
 * List outstanding (unconfirmed, unexpired) partner invitations (#1682).
 */
export async function GET() {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) return guard.response;

  const invites = await listOutstandingPartnerInviteTokens();
  return NextResponse.json({ invites });
}

/**
 * DELETE /api/admin/family-groups/partner-invites?id=TOKEN_ID
 * Revoke an outstanding partner invitation.
 */
export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) return guard.response;

  const tokenId = req.nextUrl.searchParams.get("id")?.trim();
  if (!tokenId) {
    return NextResponse.json({ error: "Invitation id required" }, { status: 400 });
  }

  const revoked = await revokePartnerInviteToken({
    tokenId,
    adminMemberId: guard.session.user.id,
  });

  if (!revoked) {
    return NextResponse.json(
      { error: "Invitation not found or already resolved" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
}
