import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { resolveMemberFamily } from "@/lib/resolve-member-family";

/**
 * DEPRECATED / ORPHANED (as of #1376): this route currently has no callers.
 * Both admin booking-on-behalf pickers moved to the bookings-scoped endpoints
 * (/api/admin/bookings/[id]/eligible-family and
 * /api/admin/bookings/eligible-family), which serve the same shape but gate on
 * bookings:edit. Retained (not deleted) for a potential membership-surface use
 * of the member-scoped, membership:view-gated variant; slated for removal if no
 * consumer emerges. See #1419.
 *
 * GET /api/admin/members/[id]/family
 * Returns the target member's family group members for admin booking-on-behalf.
 * Same shape as /api/members/family but for any member (admin only).
 *
 * This route lives under /api/admin/members, so the bare requireAdmin() infers
 * the membership:view requirement. The bookings-scoped on-behalf pickers
 * (/api/admin/bookings/[id]/eligible-family and
 * /api/admin/bookings/eligible-family) serve the SAME shape via the shared
 * resolveMemberFamily() helper but gate on bookings:edit instead, so a Booking
 * Officer without membership:view can still attach member identities (#1376).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { id: memberId } = await params;

  const family = await resolveMemberFamily(memberId);
  if (!family) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  return NextResponse.json(family);
}
