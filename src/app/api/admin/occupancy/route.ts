import { NextRequest, NextResponse } from "next/server";
import {
  getAdminOccupancyMonth,
  parseOccupancyMonth,
} from "@/lib/admin-occupancy";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET /api/admin/occupancy?month=YYYY-MM
 * Returns operational guest occupancy per lodge night for one calendar month.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const parsedMonth = parseOccupancyMonth(req.nextUrl.searchParams.get("month"));
  if (!parsedMonth.ok) {
    return NextResponse.json({ error: parsedMonth.error }, { status: 400 });
  }

  return NextResponse.json(await getAdminOccupancyMonth(parsedMonth));
}
