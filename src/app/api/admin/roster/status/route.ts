import { NextRequest, NextResponse } from "next/server"
import { parseOccupancyMonth } from "@/lib/admin-occupancy"
import { resolveOptionalActiveLodgeId } from "@/lib/lodges"
import { prisma } from "@/lib/prisma"
import { getRosterMonthStatus } from "@/lib/roster-status"
import { requireAdmin } from "@/lib/session-guards"

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
}

/**
 * GET /api/admin/roster/status?month=YYYY-MM[&lodgeId=]
 * Returns the per-date roster colour status for one calendar month, powering
 * the roster calendar overlay. Booking-granularity coverage: see
 * `computeRosterDayStatuses`.
 *
 * An explicit `lodgeId` scopes the overlay to one lodge so it matches the
 * lodge-filtered roster list below it (#1587 item 3); it is validated the same
 * way the roster list route does (`resolveOptionalActiveLodgeId` → 400 for an
 * unknown/inactive lodge). Unlike `/api/admin/roster/[date]`, an omitted
 * `lodgeId` is NOT resolved to the default lodge: it is left club-wide so the
 * single-active-lodge overlay stays byte-identical to before multi-lodge.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "lodge", level: "view" },
  })
  if (!guard.ok) return guard.response

  const parsedMonth = parseOccupancyMonth(req.nextUrl.searchParams.get("month"))
  if (!parsedMonth.ok) {
    return NextResponse.json({ error: parsedMonth.error }, { status: 400 })
  }

  const requestedLodgeId = req.nextUrl.searchParams.get("lodgeId")
  let lodgeId: string | undefined
  if (requestedLodgeId) {
    const resolved = await resolveOptionalActiveLodgeId(prisma, requestedLodgeId)
    if (!resolved) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      )
    }
    lodgeId = resolved
  }

  const statuses = await getRosterMonthStatus({ month: parsedMonth.month, lodgeId })
  return NextResponse.json({ month: parsedMonth.month, statuses })
}
