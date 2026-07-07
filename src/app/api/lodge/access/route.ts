import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth, resolveKioskLodgeId } from "@/lib/lodge-auth";
import { getKioskAccessInfo } from "@/lib/kiosk-access";
import { countActiveLodges } from "@/lib/lodges";
import { parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

/**
 * Name of the lodge this kiosk session operates, for the kiosk header —
 * only when a second active lodge exists (ADR-002 presentation rule), so
 * single-lodge clubs see no change.
 */
async function kioskLodgeName(
  authResult: Parameters<typeof resolveKioskLodgeId>[0],
): Promise<string | null> {
  try {
    if ((await countActiveLodges(prisma)) < 2) return null;
    const lodgeId = await resolveKioskLodgeId(authResult, prisma);
    if (!lodgeId) return null;
    const lodge = await prisma.lodge.findUnique({
      where: { id: lodgeId },
      select: { name: true },
    });
    return lodge?.name ?? null;
  } catch {
    return null;
  }
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * GET /api/lodge/access?date=YYYY-MM-DD
 * Returns the user's kiosk access tier and capabilities for the given date.
 */
export async function GET(req: NextRequest) {
  const dateStr = req.nextUrl.searchParams.get("date");
  if (!dateStr || !dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid or missing date parameter" }, { status: 400 });
  }

  const date = parseDateOnly(dateStr);
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const authResult = await checkLodgeAuth(dateStr, {
    request: req,
  });
  if (authResult.error) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status! });
  }

  if ("pinSession" in authResult && authResult.pinSession) {
    return NextResponse.json({
      tier: "hut-leader",
      dateRange: authResult.pinSession.dateRange,
      canManageRoster: true,
      canMarkAttendance: true,
      canCompleteChores: true,
      lodgeName: await kioskLodgeName(authResult),
    });
  }

  if ("member" in authResult && authResult.member) {
    const access = await getKioskAccessInfo(authResult.member, date);

    return NextResponse.json({
      ...access,
      lodgeName: await kioskLodgeName(authResult),
    });
  }

  return NextResponse.json({
    tier: "none",
    dateRange: null,
    canManageRoster: false,
    canMarkAttendance: false,
    canCompleteChores: false,
  });
}
