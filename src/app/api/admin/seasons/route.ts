import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { bookableAgeTierEnum } from "@/lib/age-tier-schema"
import { logAudit } from "@/lib/audit"
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only"

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
})

const seasonSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.enum(["WINTER", "SUMMER"]),
  startDate: dateOnlyString,
  endDate: dateOnlyString,
  active: z.boolean().default(true),
  rates: z.array(
    z.object({
      ageTier: bookableAgeTierEnum,
      isMember: z.boolean(),
      pricePerNightCents: z.number().int().min(0),
    })
  ).min(1, "Must provide at least one rate"),
})

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const seasons = await prisma.season.findMany({
    include: { rates: true },
    orderBy: { startDate: "desc" },
  })

  return NextResponse.json(seasons)
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await req.json()
  const parsed = seasonSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { name, type, startDate, endDate, active, rates } = parsed.data

  const parsedStartDate = parseDateOnly(startDate)
  const parsedEndDate = parseDateOnly(endDate)

  if (parsedEndDate <= parsedStartDate) {
    return NextResponse.json(
      { error: "End date must be after start date" },
      { status: 400 }
    )
  }

  // Check for overlapping seasons
  const overlapping = await prisma.season.findFirst({
    where: {
      AND: [
        { startDate: { lte: parsedEndDate } },
        { endDate: { gte: parsedStartDate } },
      ],
    },
  })

  if (overlapping) {
    return NextResponse.json(
      { error: `Dates overlap with existing season: ${overlapping.name}` },
      { status: 400 }
    )
  }

  const season = await prisma.season.create({
    data: {
      name,
      type,
      startDate: parsedStartDate,
      endDate: parsedEndDate,
      active,
      rates: {
        create: rates.map((rate) => ({
          ageTier: rate.ageTier,
          isMember: rate.isMember,
          pricePerNightCents: rate.pricePerNightCents,
        })),
      },
    },
    include: { rates: true },
  })

  logAudit({
    action: "season.create",
    memberId: session.user.id,
    targetId: season.id,
    details: `Created season: ${name}`,
  });

  return NextResponse.json(season, { status: 201 })
}
