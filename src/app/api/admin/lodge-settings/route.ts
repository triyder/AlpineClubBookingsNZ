import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { CLUB_CONFIG_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import {
  loadLodgeSettings,
  updateLodgeSettings,
} from "@/lib/lodge-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { invalidatePublicLodgeCapacity } from "@/lib/public-layout-cache";

// Per-lodge scope (lodge-scoping contract): an explicit lodgeId must name
// an active lodge; omitted keeps the legacy single-row behaviour.
async function validateLodgeScope(lodgeId: string | null | undefined) {
  if (!lodgeId) return { ok: true as const };
  const lodge = await prisma.lodge.findUnique({
    where: { id: lodgeId },
    select: { active: true },
  });
  if (!lodge?.active) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      ),
    };
  }
  return { ok: true as const };
}

const settingsSchema = z
  .object({
    // Null clears the override and falls back to the club config bed total.
    capacity: z.number().int().positive().max(100000).nullable(),
    hutLeaderLookaheadDays: z.number().int().min(1).max(365).optional(),
    // Per-lodge school-group soft cap; null clears it to the code default.
    schoolGroupSoftCap: z.number().int().positive().max(100000).nullable().optional(),
    // Lodge whose per-lodge settings are edited; the lookahead stays
    // club-wide regardless.
    lodgeId: z.string().min(1).optional(),
  })
  .strict();

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const lodgeId = new URL(request.url).searchParams.get("lodgeId");
  const scope = await validateLodgeScope(lodgeId);
  if (!scope.ok) return scope.response;

  const settings = await loadLodgeSettings(prisma, lodgeId);
  return NextResponse.json({
    capacity: settings.capacity,
    hutLeaderLookaheadDays: settings.hutLeaderLookaheadDays,
    schoolGroupSoftCap: settings.schoolGroupSoftCap,
    clubConfigCapacity: CLUB_CONFIG_LODGE_CAPACITY,
  });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const body = settingsSchema.safeParse(json.body);
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid input", details: body.error.flatten() },
      { status: 400 },
    );
  }

  const scope = await validateLodgeScope(body.data.lodgeId);
  if (!scope.ok) return scope.response;

  const previousSettings = await loadLodgeSettings(prisma, body.data.lodgeId);
  const settings = await updateLodgeSettings({
    capacity: body.data.capacity,
    hutLeaderLookaheadDays:
      body.data.hutLeaderLookaheadDays ??
      previousSettings.hutLeaderLookaheadDays,
    // Omitted keeps the current value; explicit null clears to the default.
    schoolGroupSoftCap:
      body.data.schoolGroupSoftCap === undefined
        ? previousSettings.schoolGroupSoftCap
        : body.data.schoolGroupSoftCap,
    updatedByMemberId: guard.session.user.id,
    lodgeId: body.data.lodgeId,
  });
  invalidatePublicLodgeCapacity();

  await createAuditLog({
    action: "LODGE_SETTINGS_UPDATED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "LodgeSettings",
    entityId: body.data.lodgeId ?? "default",
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: "Lodge settings updated",
    metadata: {
      previousCapacity: previousSettings.capacity,
      newCapacity: settings.capacity,
      previousHutLeaderLookaheadDays:
        previousSettings.hutLeaderLookaheadDays,
      newHutLeaderLookaheadDays: settings.hutLeaderLookaheadDays,
    },
  });

  return NextResponse.json({
    capacity: settings.capacity,
    hutLeaderLookaheadDays: settings.hutLeaderLookaheadDays,
    schoolGroupSoftCap: settings.schoolGroupSoftCap,
    clubConfigCapacity: CLUB_CONFIG_LODGE_CAPACITY,
  });
}
