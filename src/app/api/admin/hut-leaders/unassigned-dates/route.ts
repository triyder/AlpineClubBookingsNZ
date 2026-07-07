import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { parseOccupancyMonth } from "@/lib/admin-occupancy";
import { addDaysDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";

/**
 * GET /api/admin/hut-leaders/unassigned-dates
 *
 * With no query params, returns dates in the configured hut-leader lookahead
 * window that have paid/operational bookings but no HutLeaderAssignment (the
 * amber "Upcoming Dates Without…" card — unchanged).
 *
 * Optional windowing (used to paint one calendar month red on the redesigned
 * assignment page):
 *   ?month=YYYY-MM                — first→last day of that calendar month
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD — an explicit inclusive date-only window
 * Bad input returns 400.
 */
export async function GET(req?: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const searchParams = req ? new URL(req.url).searchParams : new URLSearchParams();
  const month = searchParams.get("month");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  let window: { from: Date; to: Date } | undefined;

  if (month !== null) {
    const parsed = parseOccupancyMonth(month);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    // parseOccupancyMonth's endDate is the first of the NEXT month (exclusive);
    // step back one day for an inclusive last-of-month window.
    window = { from: parsed.startDate, to: addDaysDateOnly(parsed.endDate, -1) };
  } else if (from !== null || to !== null) {
    if (!from || !to || !isDateOnlyString(from) || !isDateOnlyString(to)) {
      return NextResponse.json(
        { error: "from and to are required as YYYY-MM-DD" },
        { status: 400 },
      );
    }
    if (from > to) {
      return NextResponse.json(
        { error: "from must be before or equal to to" },
        { status: 400 },
      );
    }
    window = { from: parseDateOnly(from), to: parseDateOnly(to) };
  }

  return NextResponse.json({
    unassignedDates: await getUnassignedHutLeaderDates(window),
  });
}
