import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { logAudit } from "@/lib/audit"
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only"

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
})

const createSchema = z.object({
  name: z.string().min(1).max(200),
  startDate: dateOnlyString,
  endDate: dateOnlyString,
  triggerDays: z.array(z.number().int().min(0).max(6)).min(1, "At least one trigger day is required"),
  minimumNights: z.number().int().min(2, "Minimum nights must be at least 2"),
  active: z.boolean().optional(),
})

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const policies = await prisma.minimumStayPolicy.findMany({
    orderBy: { startDate: "desc" },
  })

  return NextResponse.json(policies)
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  try {
    const body = await request.json()
    const data = createSchema.parse(body)

    const startDate = parseDateOnly(data.startDate)
    const endDate = parseDateOnly(data.endDate)

    if (endDate <= startDate) {
      return NextResponse.json(
        { error: "End date must be after start date" },
        { status: 400 }
      )
    }

    const policy = await prisma.minimumStayPolicy.create({
      data: {
        name: data.name,
        startDate,
        endDate,
        triggerDays: data.triggerDays,
        minimumNights: data.minimumNights,
        active: data.active ?? true,
      },
    })

    logAudit({
      action: "minimum-stay-policy.create",
      memberId: session.user.id,
      details: `Created "${data.name}": min ${data.minimumNights} nights`,
    })

    return NextResponse.json(policy, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      )
    }
    return NextResponse.json(
      { error: "Failed to create minimum stay policy" },
      { status: 500 }
    )
  }
}
