import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { createAuditLog } from "@/lib/audit"

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  recommendedPeopleMin: z.number().int().min(1).optional(),
  recommendedPeopleMax: z.number().int().min(1).optional(),
  isEssential: z.boolean().optional(),
  ageRestriction: z.enum(["ANY", "ADULTS_ONLY", "MIXED_PREFERRED", "ADULT_SUPERVISED"]).optional(),
  conditionalNote: z.string().nullable().optional(),
  minAge: z.number().int().min(0).optional(),
  sortOrder: z.number().int().optional(),
  timeOfDay: z.enum(["MORNING", "EVENING", "ANYTIME"]).optional(),
  frequencyMode: z.enum(["DAILY", "EVERY_X_DAYS", "SPECIFIC_DAYS"]).optional(),
  frequencyDays: z.number().int().min(2).nullable().optional(),
  frequencyDaysOfWeek: z.array(z.number().int().min(1).max(7)).optional(),
  active: z.boolean().optional(),
})

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params
  const body = await req.json()
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const data = parsed.data
  if (
    data.recommendedPeopleMin !== undefined &&
    data.recommendedPeopleMax !== undefined &&
    data.recommendedPeopleMax < data.recommendedPeopleMin
  ) {
    return NextResponse.json(
      { error: "Max people must be >= min people" },
      { status: 400 }
    )
  }

  // Snapshot the row for before/after audit metadata (mirrors the
  // lodge-settings editor loading its previous settings before writing).
  const before = await prisma.choreTemplate.findUnique({ where: { id } })
  let chore
  try {
    chore = await prisma.choreTemplate.update({
      where: { id },
      data,
    })
  } catch {
    return NextResponse.json({ error: "Chore not found" }, { status: 404 })
  }

  // Audit with the acting admin as actor so the bootstrap-import six-signal
  // probe (signal 6) detects hand-configured chore templates.
  await createAuditLog({
    action: "CHORE_TEMPLATE_UPDATED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "ChoreTemplate",
    entityId: chore.id,
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: "Chore template updated",
    metadata: {
      lodgeId: chore.lodgeId,
      changedFields: Object.keys(data),
      before: before
        ? {
            name: before.name,
            active: before.active,
            isEssential: before.isEssential,
          }
        : null,
      after: {
        name: chore.name,
        active: chore.active,
        isEssential: chore.isEssential,
      },
    },
  })

  return NextResponse.json(chore)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params

  const before = await prisma.choreTemplate.findUnique({ where: { id } })
  try {
    await prisma.choreTemplate.delete({ where: { id } })
  } catch {
    return NextResponse.json({ error: "Chore not found" }, { status: 404 })
  }

  await createAuditLog({
    action: "CHORE_TEMPLATE_DELETED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "ChoreTemplate",
    entityId: id,
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: "Chore template deleted",
    metadata: {
      lodgeId: before?.lodgeId ?? null,
      name: before?.name ?? null,
    },
  })

  return NextResponse.json({ success: true })
}
