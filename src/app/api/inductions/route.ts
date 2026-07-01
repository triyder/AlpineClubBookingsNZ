import { NextResponse } from "next/server";
import { hasActiveHutLeaderAssignment } from "@/lib/hut-leader";
import {
  canSignOff,
  getInductionForMember,
  listInductionsAwaitingSignOff,
  type SignerContext,
} from "@/lib/induction";
import { hasAccessRole, hasAdminAccess } from "@/lib/access-roles";
import { requireActiveSession } from "@/lib/session-guards";

export async function GET() {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const memberId = guard.session.user.id;

  const ctx: SignerContext = {
    memberId,
    isAdmin: hasAdminAccess(guard.session.user),
    isHutLeader:
      hasAccessRole(guard.session.user, "USER") &&
      (await hasActiveHutLeaderAssignment(memberId)),
  };

  const [ownRaw, awaiting] = await Promise.all([
    getInductionForMember(memberId),
    listInductionsAwaitingSignOff(ctx),
  ]);

  const own = ownRaw
    ? {
        ...ownRaw,
        assignedSigners: ownRaw.assignedSigners.map((s) => ({
          memberId: s.memberId,
          firstName: s.member.firstName,
          lastName: s.member.lastName,
          email: s.member.email,
          emailSentAt: s.emailSentAt,
        })),
      }
    : null;

  return NextResponse.json({
    own,
    awaiting: awaiting.map((induction) => ({
      id: induction.id,
      kind: induction.kind,
      createdAt: induction.createdAt,
      requiredSignOffs: induction.requiredSignOffs,
      signOffCount: induction._count.signOffs,
      member: {
        firstName: induction.member.firstName,
        lastName: induction.member.lastName,
      },
    })),
    signer: {
      isAdmin: ctx.isAdmin,
      isHutLeader: ctx.isHutLeader,
      canSignOwn: ownRaw ? canSignOff(ownRaw, ctx).allowed : false,
    },
  });
}
