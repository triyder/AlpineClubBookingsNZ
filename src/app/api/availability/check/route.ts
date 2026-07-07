import { NextRequest, NextResponse } from "next/server";
import { checkCapacity } from "@/lib/capacity";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getDefaultLodgeId } from "@/lib/lodges";
import { z } from "zod";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const availabilityCheckQuerySchema = z.object({
  checkIn: dateOnlyString.transform(parseDateOnly),
  checkOut: dateOnlyString.transform(parseDateOnly),
  lodgeId: z.string().min(1).optional(),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const parsed = availabilityCheckQuerySchema.safeParse({
    checkIn: request.nextUrl.searchParams.get("checkIn"),
    checkOut: request.nextUrl.searchParams.get("checkOut"),
    lodgeId: request.nextUrl.searchParams.get("lodgeId") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { checkIn, checkOut, lodgeId: requestedLodgeId } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "checkOut must be after checkIn" }, { status: 400 });
  }

  let lodgeId: string;
  if (requestedLodgeId) {
    const lodge = await prisma.lodge.findUnique({
      where: { id: requestedLodgeId },
      select: { id: true, active: true },
    });
    if (!lodge || !lodge.active) {
      return NextResponse.json({ error: "Unknown or inactive lodgeId" }, { status: 400 });
    }
    lodgeId = lodge.id;
  } else {
    lodgeId = await getDefaultLodgeId(prisma);
  }

  const result = await checkCapacity(lodgeId, checkIn, checkOut, 1);

  return NextResponse.json({
    minAvailable: result.minAvailable,
    nightDetails: result.nightDetails.map((n) => ({
      date: formatDateOnly(n.date),
      occupiedBeds: n.occupiedBeds,
      availableBeds: n.availableBeds,
    })),
  });
}
