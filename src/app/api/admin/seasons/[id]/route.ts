import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { bookableAgeTierEnum } from "@/lib/age-tier-schema"
import { logAudit } from "@/lib/audit"
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only"
import { lodgeNullTolerantScope } from "@/lib/lodges"

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
})

const updateSeasonSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(["WINTER", "SUMMER"]).optional(),
  startDate: dateOnlyString.optional(),
  endDate: dateOnlyString.optional(),
  active: z.boolean().optional(),
  rates: z.array(
    z.object({
      ageTier: bookableAgeTierEnum,
      isMember: z.boolean(),
      pricePerNightCents: z.number().int().min(0),
    })
  ).min(1).optional(),
})

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { id } = await params

  const season = await prisma.season.findUnique({
    where: { id },
    include: { rates: true },
  })

  if (!season) {
    return NextResponse.json({ error: "Season not found" }, { status: 404 })
  }

  return NextResponse.json(season)
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params
  const body = await req.json()
  const parsed = updateSeasonSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const existing = await prisma.season.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: "Season not found" }, { status: 404 })
  }

  const { rates, startDate, endDate, ...seasonData } = parsed.data

  const parsedStartDate = startDate ? parseDateOnly(startDate) : undefined
  const parsedEndDate = endDate ? parseDateOnly(endDate) : undefined
  const effectiveStart = parsedStartDate ?? existing.startDate
  const effectiveEnd = parsedEndDate ?? existing.endDate

  if (effectiveEnd <= effectiveStart) {
    return NextResponse.json(
      { error: "End date must be after start date" },
      { status: 400 }
    )
  }

  // Check overlaps excluding current season, scoped to the season's own
  // lodge (lodges may run different season windows). A season still missing
  // its lodgeId (expand-release tolerance) conservatively checks every lodge.
  if (startDate || endDate) {
    const overlapping = await prisma.season.findFirst({
      where: {
        id: { not: id },
        AND: [
          { startDate: { lte: effectiveEnd } },
          { endDate: { gte: effectiveStart } },
          ...(existing.lodgeId
            ? [lodgeNullTolerantScope(existing.lodgeId)]
            : []),
        ],
      },
    })

    if (overlapping) {
      return NextResponse.json(
        { error: `Dates overlap with existing season: ${overlapping.name}` },
        { status: 400 }
      )
    }
  }

  const season = await prisma.$transaction(async (tx) => {
    // Update season fields
    await tx.season.update({
      where: { id },
      data: {
        ...seasonData,
        ...(parsedStartDate && { startDate: parsedStartDate }),
        ...(parsedEndDate && { endDate: parsedEndDate }),
      },
    })

    // Update rates if provided
    if (rates) {
      await tx.seasonRate.deleteMany({ where: { seasonId: id } })
      await tx.seasonRate.createMany({
        data: rates.map((rate) => ({
          seasonId: id,
          ageTier: rate.ageTier,
          isMember: rate.isMember,
          pricePerNightCents: rate.pricePerNightCents,
        })),
      })
    }

    return tx.season.findUnique({
      where: { id },
      include: { rates: true },
    })
  })

  logAudit({
    action: "season.update",
    memberId: session.user.id,
    targetId: id,
    details: `Updated season: ${existing.name}`,
  })

  return NextResponse.json(season)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params

  const existing = await prisma.season.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: "Season not found" }, { status: 404 })
  }

  await prisma.season.delete({ where: { id } })

  logAudit({
    action: "season.delete",
    memberId: session.user.id,
    targetId: id,
    details: `Deleted season: ${existing.name}`,
  })

  return NextResponse.json({ success: true })
}
