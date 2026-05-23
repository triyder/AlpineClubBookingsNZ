import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  EMAIL_MESSAGE_SETTINGS_ID,
  loadPersistedEmailMessageSettings,
  normalizeEmailMessagePublicUrl,
  normalizeEmailMessageSettings,
} from "@/lib/email-message-settings";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";

const settingsSchema = z
  .object({
    clubName: z.string().trim().min(1).max(200).nullable().optional(),
    bookingsName: z.string().trim().min(1).max(200).nullable().optional(),
    lodgeName: z.string().trim().min(1).max(200).nullable().optional(),
    emailFromName: z.string().trim().min(1).max(200).nullable().optional(),
    supportEmail: z.string().trim().email().max(320).nullable().optional(),
    contactEmail: z.string().trim().email().max(320).nullable().optional(),
    publicUrl: z
      .string()
      .trim()
      .url()
      .max(500)
      .refine((value) => normalizeEmailMessagePublicUrl(value) !== null, {
        message: "Public URL must use http or https",
      })
      .transform((value) => normalizeEmailMessagePublicUrl(value)!)
      .nullable()
      .optional(),
    lodgeTravelNote: z.string().trim().min(1).max(2000).nullable().optional(),
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

  const persisted = await loadPersistedEmailMessageSettings();
  return NextResponse.json({
    settings: normalizeEmailMessageSettings(persisted),
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

  const before = await prisma.emailMessageSetting.findUnique({
    where: { id: EMAIL_MESSAGE_SETTINGS_ID },
  });
  const data = {
    ...parsed.data,
    updatedByMemberId: session.user.id,
  };

  const record = await prisma.emailMessageSetting.upsert({
    where: { id: EMAIL_MESSAGE_SETTINGS_ID },
    create: {
      id: EMAIL_MESSAGE_SETTINGS_ID,
      ...data,
    },
    update: data,
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "EMAIL_MESSAGE_SETTINGS_UPDATED",
      actor: { memberId: session.user.id },
      entity: { type: "EmailMessageSetting", id: EMAIL_MESSAGE_SETTINGS_ID },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Email message settings updated",
      metadata: {
        changedKeys: Object.keys(parsed.data),
        previousSettings: before,
        newSettings: parsed.data,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({
    settings: normalizeEmailMessageSettings(record),
    persisted: record,
  });
}
