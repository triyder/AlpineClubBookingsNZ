import { NextRequest, NextResponse } from "next/server"
import { parseOccupancyMonth } from "@/lib/admin-occupancy"
import { getRosterMonthStatus } from "@/lib/roster-status"
import { requireAdmin } from "@/lib/session-guards"

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
}

/**
 * GET /api/admin/roster/status?month=YYYY-MM
 * Returns the per-date roster colour status for one calendar month, powering
 * the roster calendar overlay. Booking-granularity coverage: see
 * `computeRosterDayStatuses`.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(adminGuardOptions)
  if (!guard.ok) return guard.response

  const parsedMonth = parseOccupancyMonth(req.nextUrl.searchParams.get("month"))
  if (!parsedMonth.ok) {
    return NextResponse.json({ error: parsedMonth.error }, { status: 400 })
  }

  const statuses = await getRosterMonthStatus({ month: parsedMonth.month })
  return NextResponse.json({ month: parsedMonth.month, statuses })
}
