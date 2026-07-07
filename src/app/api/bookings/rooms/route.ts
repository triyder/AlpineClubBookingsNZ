import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
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
  // passes its chosen lodge so members only see that lodge's rooms. Rooms
  // without a lodgeId (expand-release tolerance) show for every lodge.
  const lodgeId = request.nextUrl.searchParams.get("lodgeId");
  const rooms = await prisma.lodgeRoom.findMany({
    where: {
      active: true,
      ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
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
