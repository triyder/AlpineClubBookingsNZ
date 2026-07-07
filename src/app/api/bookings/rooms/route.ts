import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  getEligibleLodgeIdsForMember,
  isMemberEligibleToBookLodge,
} from "@/lib/lodge-access";
import { lodgeNullTolerantScope } from "@/lib/lodges";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const modules = await loadEffectiveModuleFlags();
  if (!modules.bedAllocation) {
    return NextResponse.json({ enabled: false, rooms: [] });
  }

  // Room preferences are per lodge (multi-lodge phase 8): the booking flow
  // passes its chosen lodge so members only see that lodge's rooms.
  // (LodgeRoom.lodgeId is NOT NULL since migration 20260708001100; the old
  // null-lodge expand-release tolerance no longer applies.)
  const lodgeId = request.nextUrl.searchParams.get("lodgeId");
  // A BOOKING_RESTRICTION-ed member must not read a forbidden lodge's rooms,
  // mirroring the booking create path — whether they name the lodge or list
  // across lodges. Both branches gate on the same eligibility rule (item 6 of
  // #1587): a named forbidden lodge 403s (an access-denied on a named
  // resource); the cross-lodge listing is filtered to the member's eligible
  // lodges (a listing omits what the member cannot see, never 403 — matching
  // /api/lodges). The two sets are identical by construction because both
  // derive from getEligibleLodgeIdsForMember.
  let lodgeScope: { lodgeId?: string | { in: string[] } } = {};
  if (lodgeId) {
    if (!(await isMemberEligibleToBookLodge(prisma, session.user.id, lodgeId))) {
      return NextResponse.json(
        { error: "This member cannot book the selected lodge." },
        { status: 403 }
      );
    }
    lodgeScope = lodgeNullTolerantScope(lodgeId);
  } else {
    const eligible = await getEligibleLodgeIdsForMember(
      prisma,
      session.user.id
    );
    // An unrestricted member (default-open) sees every lodge's rooms as before;
    // a restricted member sees only their eligible lodges (empty when none of
    // those lodges have active rooms).
    if (!eligible.allLodges) {
      lodgeScope = { lodgeId: { in: eligible.lodgeIds } };
    }
  }
  const rooms = await prisma.lodgeRoom.findMany({
    where: {
      active: true,
      ...lodgeScope,
    },
    include: {
      beds: { where: { active: true }, select: { id: true } },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
  });

  return NextResponse.json({
    enabled: true,
    rooms: rooms.map((room) => ({
      id: room.id,
      name: room.name,
      bedCount: room.beds.length,
    })),
  });
}
