import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { countActiveLodges } from "@/lib/lodges";
import {
  CLUB_MODULE_SETTINGS_ID,
  buildClubModuleSettingsPayload,
  loadClubModuleSettings,
  normalizeClubModuleSettings,
} from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import {
  MODULE_KEYS,
  type ModuleKey,
  type ModuleSettingsValues,
} from "@/config/modules";

const moduleSettingsSchema = z
  .object(
    Object.fromEntries(MODULE_KEYS.map((key) => [key, z.boolean()])) as Record<
      ModuleKey,
      z.ZodBoolean
    >,
  )
  .strict();

const updateSchema = z
  .object({
    settings: moduleSettingsSchema,
  })
  .strict();

function getChanges(
  before: ModuleSettingsValues,
  after: ModuleSettingsValues,
) {
  return MODULE_KEYS.filter((key) => before[key] !== after[key]).map((key) => ({
    key,
    previous: before[key],
    next: after[key],
  }));
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  return NextResponse.json(await loadClubModuleSettings());
}

export async function PUT(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.clubModuleSettings.findUnique({
    where: { id: CLUB_MODULE_SETTINGS_ID },
  });
  const before = normalizeClubModuleSettings(existing);
  const after = parsed.data.settings;
  const changes = getChanges(before, after);

  // A multi-lodge club must keep the lodge-management surface reachable
  // (docs/multi-lodge/decisions/ADR-002-core-data-model-not-a-module.md).
  if (before.multiLodge && !after.multiLodge) {
    const activeLodges = await countActiveLodges(prisma);
    if (activeLodges > 1) {
      return NextResponse.json(
        {
          error:
            "Multiple lodges cannot be turned off while more than one active lodge exists. Deactivate the extra lodges first.",
        },
        { status: 409 },
      );
    }
  }
  const write = prisma.clubModuleSettings.upsert({
    where: { id: CLUB_MODULE_SETTINGS_ID },
    create: {
      id: CLUB_MODULE_SETTINGS_ID,
      ...after,
      updatedByMemberId: session.user.id,
    },
    update: {
      ...after,
      updatedByMemberId: session.user.id,
    },
  });

  const record =
    changes.length > 0
      ? (
          await prisma.$transaction([
            write,
            prisma.auditLog.create(
              buildStructuredAuditLogCreateArgs({
                action: "CLUB_MODULE_SETTINGS_UPDATED",
                actor: { memberId: session.user.id },
                entity: {
                  type: "ClubModuleSettings",
                  id: CLUB_MODULE_SETTINGS_ID,
                },
                category: "admin",
                severity: "important",
                outcome: "success",
                summary: "Club module settings updated",
                metadata: {
                  changedModuleKeys: changes.map((change) => change.key),
                  changes,
                  previousSettings: before,
                  newSettings: after,
                },
                request: getAuditRequestContext(request),
              }),
            ),
          ])
        )[0]
      : await write;

  return NextResponse.json(buildClubModuleSettingsPayload(record));
}
