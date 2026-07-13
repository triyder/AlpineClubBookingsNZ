import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildStructuredAuditLogCreateArgs, getAuditRequestContext } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const settingsSchema = z.object({
  membershipTypes: z.boolean(),
  entranceFees: z.boolean(),
  hutFees: z.boolean(),
  bookingPolicySummary: z.boolean(),
  cancellationPolicy: z.boolean(),
}).strict();

const defaults = {
  membershipTypes: false,
  entranceFees: false,
  hutFees: false,
  bookingPolicySummary: false,
  cancellationPolicy: false,
};

const settingsSelect = {
  membershipTypes: true,
  entranceFees: true,
  hutFees: true,
  bookingPolicySummary: true,
  cancellationPolicy: true,
} as const;

function serializeSettings(row: typeof defaults): typeof defaults {
  return {
    membershipTypes: row.membershipTypes,
    entranceFees: row.entranceFees,
    hutFees: row.hutFees,
    bookingPolicySummary: row.bookingPolicySummary,
    cancellationPolicy: row.cancellationPolicy,
  };
}

export async function GET() {
  const guard = await requireAdmin({ permission: { area: "content", level: "view" } });
  if (!guard.ok) return guard.response;
  const settings = await prisma.publicContentSettings.findUnique({ where: { id: "default" }, select: settingsSelect });
  return NextResponse.json({ settings: settings ? serializeSettings(settings) : defaults });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({ permission: { area: "content", level: "edit" } });
  if (!guard.ok) return guard.response;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  const settings = await prisma.$transaction(async (tx) => {
    const before = await tx.publicContentSettings.findUnique({ where: { id: "default" }, select: settingsSelect });
    const saved = await tx.publicContentSettings.upsert({
      where: { id: "default" },
      update: { ...parsed.data, updatedByMemberId: guard.session.user.id },
      create: { id: "default", ...parsed.data, updatedByMemberId: guard.session.user.id },
    });
    await tx.auditLog.create(buildStructuredAuditLogCreateArgs({
      action: "PUBLIC_CONTENT_SETTINGS_UPDATED",
      actor: { memberId: guard.session.user.id },
      entity: { type: "PublicContentSettings", id: "default" },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Public fee and policy content visibility updated",
      metadata: { before: before ? serializeSettings(before) : defaults, after: parsed.data },
      request: getAuditRequestContext(request),
    }));
    return saved;
  });
  revalidatePath("/", "layout");
  return NextResponse.json({ settings: serializeSettings(settings) });
}
