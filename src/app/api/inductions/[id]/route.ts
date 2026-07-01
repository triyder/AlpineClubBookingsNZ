import { NextRequest, NextResponse } from "next/server";
import { hasActiveHutLeaderAssignment } from "@/lib/hut-leader";
import {
  canSignOff,
  getInductionById,
  resolveSignerRole,
  type SignerContext,
} from "@/lib/induction";
import { INDUCTION_SIGN_OFF_DECLARATION } from "@/lib/induction-checklist-template";
import { hasAccessRole, hasAdminAccess } from "@/lib/access-roles";
import { requireActiveSession } from "@/lib/session-guards";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const memberId = guard.session.user.id;
  const ctx: SignerContext = {
    memberId,
    isAdmin: hasAdminAccess(guard.session.user),
    isHutLeader:
      hasAccessRole(guard.session.user, "USER") &&
      (await hasActiveHutLeaderAssignment(memberId)),
  };

  const induction = await getInductionById(id);
  if (!induction) {
    return NextResponse.json({ error: "Induction not found" }, { status: 404 });
  }

  const isInductee = induction.memberId === memberId;
  const assignedIds = induction.assignedSigners.map((signer) => signer.memberId);
  const role = resolveSignerRole(ctx, induction.application, assignedIds);
  if (!isInductee && !role) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const eligibility = canSignOff(induction, ctx);

  return NextResponse.json({
    induction,
    declaration: INDUCTION_SIGN_OFF_DECLARATION,
    viewer: {
      isInductee,
      canSign: eligibility.allowed,
      role: eligibility.role ?? null,
      reason: eligibility.reason ?? null,
    },
  });
}
