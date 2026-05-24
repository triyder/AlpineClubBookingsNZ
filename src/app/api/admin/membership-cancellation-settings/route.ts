import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  MEMBERSHIP_CANCELLATION_SETTINGS_ID,
  normalizeMembershipCancellationSettings,
} from "@/lib/membership-cancellation-settings";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";

function nullableTrimmedString(maxLength: number) {
  return z
    .preprocess(
      (value) => {
        if (typeof value !== "string") return value;
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
      },
      z.string().min(1).max(maxLength).nullable().optional(),
    );
}

const xeroGroupSchema = z
  .object({
    groupId: z.string().trim().min(1).max(200),
    groupName: nullableTrimmedString(200),
  })
  .strict();

const settingsSchema = z
  .object({
    warningText: nullableTrimmedString(4000),
    rejoinProcessText: nullableTrimmedString(4000),
    xeroArchiveContactsOnCancellation: z.boolean().optional(),
    xeroContactGroups: z.array(xeroGroupSchema).max(20).optional(),
  })
  .strict();

async function requireAdmin() {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      session: null,
    };
  }
  if (session.user.role !== "ADMIN") {
    return {
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      session: null,
    };
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return { response: inactiveResponse, session: null };
  }
  return { response: null, session };
}

export async function GET() {
  const { response } = await requireAdmin();
  if (response) return response;

  const persisted = await prisma.membershipCancellationSetting.findUnique({
    where: { id: MEMBERSHIP_CANCELLATION_SETTINGS_ID },
    include: {
      xeroContactGroups: {
        orderBy: [{ groupName: "asc" }, { groupId: "asc" }],
      },
    },
  });

  return NextResponse.json({
    settings: normalizeMembershipCancellationSettings(persisted),
    persisted,
  });
}

export async function PUT(request: NextRequest) {
  const { response, session } = await requireAdmin();
  if (response) return response;
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const normalized = normalizeMembershipCancellationSettings(parsed.data);
  const before = await prisma.membershipCancellationSetting.findUnique({
    where: { id: MEMBERSHIP_CANCELLATION_SETTINGS_ID },
    include: {
      xeroContactGroups: {
        orderBy: [{ groupName: "asc" }, { groupId: "asc" }],
      },
    },
  });

  const record = await prisma.$transaction(async (tx) => {
    await tx.membershipCancellationSetting.upsert({
      where: { id: MEMBERSHIP_CANCELLATION_SETTINGS_ID },
      create: {
        id: MEMBERSHIP_CANCELLATION_SETTINGS_ID,
        warningText: normalized.warningText,
        rejoinProcessText: normalized.rejoinProcessText,
        xeroArchiveContactsOnCancellation:
          normalized.xeroArchiveContactsOnCancellation,
        updatedByMemberId: session.user.id,
      },
      update: {
        warningText: normalized.warningText,
        rejoinProcessText: normalized.rejoinProcessText,
        xeroArchiveContactsOnCancellation:
          normalized.xeroArchiveContactsOnCancellation,
        updatedByMemberId: session.user.id,
      },
    });
    await tx.membershipCancellationXeroContactGroup.deleteMany({
      where: { settingId: MEMBERSHIP_CANCELLATION_SETTINGS_ID },
    });
    if (normalized.xeroContactGroups.length > 0) {
      await tx.membershipCancellationXeroContactGroup.createMany({
        data: normalized.xeroContactGroups.map((group) => ({
          settingId: MEMBERSHIP_CANCELLATION_SETTINGS_ID,
          groupId: group.groupId,
          groupName: group.groupName,
        })),
        skipDuplicates: true,
      });
    }

    return tx.membershipCancellationSetting.findUniqueOrThrow({
      where: { id: MEMBERSHIP_CANCELLATION_SETTINGS_ID },
      include: {
        xeroContactGroups: {
          orderBy: [{ groupName: "asc" }, { groupId: "asc" }],
        },
      },
    });
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "MEMBERSHIP_CANCELLATION_SETTINGS_UPDATED",
      actor: { memberId: session.user.id },
      entity: {
        type: "MembershipCancellationSetting",
        id: MEMBERSHIP_CANCELLATION_SETTINGS_ID,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Membership cancellation settings updated",
      metadata: {
        previousSettings: before,
        newSettings: normalizeMembershipCancellationSettings(record),
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({
    settings: normalizeMembershipCancellationSettings(record),
    persisted: record,
  });
}
