import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import {
  getAdminRosterForDate,
  rosterActionSchema,
  updateAdminRosterForDate,
} from "@/lib/admin-roster-service"
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only"
import { resolveOptionalActiveLodgeId } from "@/lib/lodges"
import { prisma } from "@/lib/prisma"
import { requireAdmin } from "@/lib/session-guards"

const paramsSchema = z.object({
  date: z.string().min(1),
})

const rosterQuerySchema = z.object({
  regenerate: z.string().optional(),
  includeNonEssential: z.string().optional(),
}).transform((value) => ({
  regenerate: value.regenerate === "true",
  includeNonEssential:
    value.includeNonEssential === undefined
      ? undefined
      : value.includeNonEssential === "true",
}))

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
}

// Lodge scope for the roster (multi-lodge phase 7 retrofit): an explicit
// ?lodgeId= must name an active lodge; omitted falls back to the club's
// default lodge, preserving single-lodge behaviour.
async function resolveRosterLodgeId(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("lodgeId") ?? undefined
  const lodgeId = await resolveOptionalActiveLodgeId(prisma, requested)
  if (!lodgeId) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      ),
    }
  }
  return { ok: true as const, lodgeId }
}

function parseRosterDate(dateStr: string) {
  if (!isDateOnlyString(dateStr)) {
    return { ok: false as const, response: NextResponse.json({ error: "Invalid date format" }, { status: 400 }) }
  }
  const date = parseDateOnly(dateStr)
  if (isNaN(date.getTime())) {
    return { ok: false as const, response: NextResponse.json({ error: "Invalid date" }, { status: 400 }) }
  }
  return { ok: true as const, date }
}

/**
 * GET /api/admin/roster/[date]
 * Returns the roster for a given date. If no assignments exist, auto-suggests.
 *
 * Query params:
 *   ?includeNonEssential=true/false  (override occupancy-based selection)
 *   ?regenerate=true                 (force re-suggest, deletes existing SUGGESTED)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const guard = await requireAdmin(adminGuardOptions)
  if (!guard.ok) return guard.response

  const parsedParams = paramsSchema.safeParse(await params)
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 }
    )
  }

  const parsedDate = parseRosterDate(parsedParams.data.date)
  if (!parsedDate.ok) return parsedDate.response

  const parsedQuery = rosterQuerySchema.safeParse({
    regenerate: req.nextUrl.searchParams.get("regenerate") ?? undefined,
    includeNonEssential: req.nextUrl.searchParams.get("includeNonEssential") ?? undefined,
  })
  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsedQuery.error.flatten() },
      { status: 400 }
    )
  }

  const lodge = await resolveRosterLodgeId(req)
  if (!lodge.ok) return lodge.response

  const result = await getAdminRosterForDate({
    date: parsedDate.date,
    dateString: parsedParams.data.date,
    regenerate: parsedQuery.data.regenerate,
    includeNonEssential: parsedQuery.data.includeNonEssential,
    lodgeId: lodge.lodgeId,
  })
  return NextResponse.json(result.body, result.init)
}

/**
 * PUT /api/admin/roster/[date]
 * Update assignments for a date (reassign guests, add/remove assignments)
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const guard = await requireAdmin(adminGuardOptions)
  if (!guard.ok) return guard.response

  const parsedParams = paramsSchema.safeParse(await params)
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 }
    )
  }

  const parsedDate = parseRosterDate(parsedParams.data.date)
  if (!parsedDate.ok) return parsedDate.response

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const parsedBody = rosterActionSchema.safeParse(body)
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsedBody.error.flatten() },
      { status: 400 }
    )
  }

  const lodge = await resolveRosterLodgeId(req)
  if (!lodge.ok) return lodge.response

  const result = await updateAdminRosterForDate({
    date: parsedDate.date,
    dateString: parsedParams.data.date,
    data: parsedBody.data,
    lodgeId: lodge.lodgeId,
  })
  return NextResponse.json(result.body, result.init)
}
