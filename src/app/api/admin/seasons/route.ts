import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { bookableAgeTierEnum } from "@/lib/age-tier-schema"
import { logAudit } from "@/lib/audit"
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only"
import {
  lodgeNullTolerantScope,
  resolveOptionalActiveLodgeId,
} from "@/lib/lodges"

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
  lodgeId: z.string().min(1).optional(),
})

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  // Null-tolerant filter: rows without a lodgeId (pre-backfill or written by
  // a draining old colour during the expand deploy) show under every lodge.
  const lodgeId = req.nextUrl.searchParams.get("lodgeId")
  const seasons = await prisma.season.findMany({
    where: lodgeId ? lodgeNullTolerantScope(lodgeId) : undefined,
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

  const lodgeId = await resolveOptionalActiveLodgeId(prisma, parsed.data.lodgeId)
  if (!lodgeId) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 }
    )
  }

  // Check for overlapping seasons at this lodge. Lodges may run different
  // season windows, so the check is per lodge; rows with a null lodgeId
  // (expand-release tolerance) conservatively overlap every lodge.
  const overlapping = await prisma.season.findFirst({
    where: {
      AND: [
        { startDate: { lte: parsedEndDate } },
        { endDate: { gte: parsedStartDate } },
        lodgeNullTolerantScope(lodgeId),
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
      lodgeId,
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
