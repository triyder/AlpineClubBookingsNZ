import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { EMAIL_TEMPLATE_KEY_SET } from "@/lib/email-message-registry";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const resetSchema = z.object({
  templateName: z.string().trim().min(1),
});

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (!EMAIL_TEMPLATE_KEY_SET.has(parsed.data.templateName)) {
    return NextResponse.json({ error: "Unknown email template" }, { status: 400 });
  }

  const result = await prisma.emailTemplateOverride.deleteMany({
    where: { templateName: parsed.data.templateName },
  });
  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "EMAIL_TEMPLATE_OVERRIDE_RESET",
      actor: { memberId: session.user.id },
      entity: {
        type: "EmailTemplateOverride",
        id: parsed.data.templateName,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Email template override reset",
      metadata: { templateName: parsed.data.templateName },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({ reset: result.count > 0 });
}
