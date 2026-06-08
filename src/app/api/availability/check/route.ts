import { NextRequest, NextResponse } from "next/server";
import { checkCapacity } from "@/lib/capacity";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const availabilityCheckQuerySchema = z.object({
  checkIn: dateOnlyString.transform(parseDateOnly),
  checkOut: dateOnlyString.transform(parseDateOnly),
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
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { checkIn, checkOut } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "checkOut must be after checkIn" }, { status: 400 });
  }

  const result = await checkCapacity(checkIn, checkOut, 1);

  return NextResponse.json({
    minAvailable: result.minAvailable,
    nightDetails: result.nightDetails.map((n) => ({
      date: formatDateOnly(n.date),
      occupiedBeds: n.occupiedBeds,
      availableBeds: n.availableBeds,
    })),
  });
}
