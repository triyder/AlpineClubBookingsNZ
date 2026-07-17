import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import {
  lodgeNullTolerantScope,
  resolveOptionalActiveLodgeId,
} from "@/lib/lodges"

const choreSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    description: z.string().optional().default(""),
    recommendedPeopleMin: z.number().int().min(1).default(1),
    recommendedPeopleMax: z.number().int().min(1).default(2),
    isEssential: z.boolean().default(false),
    ageRestriction: z
      .enum(["ANY", "ADULTS_ONLY", "MIXED_PREFERRED", "ADULT_SUPERVISED"])
      .default("ANY"),
    conditionalNote: z.string().nullable().optional().default(null),
    minAge: z.number().int().min(0).default(0),
    sortOrder: z.number().int().default(0),
    timeOfDay: z.enum(["MORNING", "EVENING", "ANYTIME"]).default("ANYTIME"),
    frequencyMode: z
      .enum(["DAILY", "EVERY_X_DAYS", "SPECIFIC_DAYS"])
      .default("DAILY"),
    frequencyDays: z.number().int().min(2).nullable().optional().default(null),
    frequencyDaysOfWeek: z
      .array(z.number().int().min(1).max(7))
      .optional()
      .default([]),
    active: z.boolean().default(true),
    lodgeId: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.frequencyMode === "SPECIFIC_DAYS" &&
      data.frequencyDaysOfWeek.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["frequencyDaysOfWeek"],
        message: "Select at least one day for SPECIFIC_DAYS chores",
      });
    }
  });

export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;
  // Null-tolerant filter: rows without a lodgeId (pre-backfill or written by
  // a draining old colour during the expand deploy) show under every lodge.
  const lodgeId = req.nextUrl.searchParams.get("lodgeId")
  // Validate an explicit lodge scope the way the POST path does (400 on
  // unknown/inactive). Omitted lists chores across every lodge, so only
  // validate when a lodgeId is supplied.
  if (lodgeId && !(await resolveOptionalActiveLodgeId(prisma, lodgeId))) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 }
    )
  }
  const chores = await prisma.choreTemplate.findMany({
    where: lodgeId ? lodgeNullTolerantScope(lodgeId) : undefined,
    orderBy: { sortOrder: "asc" },
  })
  return NextResponse.json(chores)
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const body = await req.json()
  const parsed = choreSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { lodgeId: requestedLodgeId, ...data } = parsed.data
  if (data.recommendedPeopleMax < data.recommendedPeopleMin) {
    return NextResponse.json(
      { error: "Max people must be >= min people" },
      { status: 400 }
    )
  }

  const lodgeId = await resolveOptionalActiveLodgeId(prisma, requestedLodgeId);
  if (!lodgeId) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 }
    );
  }

  const chore = await prisma.choreTemplate.create({ data: { ...data, lodgeId } })
  return NextResponse.json(chore, { status: 201 })
}
