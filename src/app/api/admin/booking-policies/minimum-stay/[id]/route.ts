import { NextRequest, NextResponse } from "next/server"
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { logAudit } from "@/lib/audit"
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only"

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
})

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  startDate: dateOnlyString.optional(),
  endDate: dateOnlyString.optional(),
  triggerDays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  minimumNights: z.number().int().min(2).optional(),
  active: z.boolean().optional(),
})

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params

  try {
    const body = await request.json()
    const data = updateSchema.parse(body)

    const existing = await prisma.minimumStayPolicy.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: "Policy not found" }, { status: 404 })
    }

    const startDate = data.startDate ? parseDateOnly(data.startDate) : existing.startDate
    const endDate = data.endDate ? parseDateOnly(data.endDate) : existing.endDate

    if (endDate <= startDate) {
      return NextResponse.json(
        { error: "End date must be after start date" },
        { status: 400 }
      )
    }

    const policy = await prisma.minimumStayPolicy.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.startDate && { startDate }),
        ...(data.endDate && { endDate }),
        ...(data.triggerDays !== undefined && { triggerDays: data.triggerDays }),
        ...(data.minimumNights !== undefined && { minimumNights: data.minimumNights }),
        ...(data.active !== undefined && { active: data.active }),
      },
    })

    logAudit({
      action: "minimum-stay-policy.update",
      memberId: session.user.id,
      targetId: id,
      details: JSON.stringify({ lodgeId: existing.lodgeId, before: existing, after: policy }),
    })

    revalidatePublicPageContent()
    return NextResponse.json(policy)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      )
    }
    return NextResponse.json(
      { error: "Failed to update minimum stay policy" },
      { status: 500 }
    )
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params

  try {
    const existing = await prisma.minimumStayPolicy.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: "Policy not found" }, { status: 404 })
    }

    // Soft delete — set active=false to preserve audit history
    await prisma.minimumStayPolicy.update({
      where: { id },
      data: { active: false },
    })

    logAudit({
      action: "minimum-stay-policy.delete",
      memberId: session.user.id,
      targetId: id,
      details: JSON.stringify({ lodgeId: existing.lodgeId, before: existing, after: { ...existing, active: false } }),
    })

    revalidatePublicPageContent()
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json(
      { error: "Failed to delete minimum stay policy" },
      { status: 500 }
    )
  }
}
