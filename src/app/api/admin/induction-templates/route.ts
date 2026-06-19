import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const TEMPLATE_INCLUDE = {
  sections: {
    orderBy: { sortOrder: "asc" as const },
    include: { items: { orderBy: { sortOrder: "asc" as const } } },
  },
};

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(50),
  cloneFromId: z.string().min(1).optional(),
});

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const templates = await prisma.inductionChecklistTemplate.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { inductions: true, sections: true } },
    },
  });

  return NextResponse.json({
    templates: templates.map((template) => ({
      id: template.id,
      name: template.name,
      version: template.version,
      sourceLabel: template.sourceLabel,
      isActive: template.isActive,
      createdAt: template.createdAt,
      sectionCount: template._count.sections,
      inductionCount: template._count.inductions,
      used: template._count.inductions > 0,
    })),
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  let sectionsCreate: object | undefined;
  if (parsed.data.cloneFromId) {
    const source = await prisma.inductionChecklistTemplate.findUnique({
      where: { id: parsed.data.cloneFromId },
      include: TEMPLATE_INCLUDE,
    });
    if (!source) {
      return NextResponse.json(
        { error: "Template to clone was not found" },
        { status: 404 }
      );
    }
    sectionsCreate = {
      create: source.sections.map((section) => ({
        title: section.title,
        description: section.description,
        priority: section.priority,
        sortOrder: section.sortOrder,
        items: {
          create: section.items.map((item) => ({
            label: item.label,
            competencyPrompt: item.competencyPrompt,
            notesPrompt: item.notesPrompt,
            isMandatory: item.isMandatory,
            requiresDemonstration: item.requiresDemonstration,
            sortOrder: item.sortOrder,
            legacySourceText: item.legacySourceText,
          })),
        },
      })),
    };
  }

  const template = await prisma.inductionChecklistTemplate.create({
    data: {
      name: parsed.data.name,
      version: parsed.data.version,
      isActive: false,
      ...(sectionsCreate ? { sections: sectionsCreate } : {}),
    },
    include: TEMPLATE_INCLUDE,
  });

  logAudit({
    action: "INDUCTION_TEMPLATE_CREATED",
    memberId: guard.session.user.id,
    targetId: template.id,
    entityType: "InductionChecklistTemplate",
    entityId: template.id,
    category: "admin",
    severity: "important",
    details: JSON.stringify({
      name: template.name,
      version: template.version,
      clonedFrom: parsed.data.cloneFromId ?? null,
    }),
  });

  return NextResponse.json({ template }, { status: 201 });
}
