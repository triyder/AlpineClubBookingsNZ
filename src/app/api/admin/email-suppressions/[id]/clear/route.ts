import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { clearEmailSuppression } from "@/lib/email-suppression";
import { logAudit } from "@/lib/audit";

const clearSuppressionSchema = z.object({
  reason: z.string().max(500).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = clearSuppressionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { id } = await context.params;
  const suppression = await clearEmailSuppression({
    id,
    clearedById: session.user.id,
    clearReason: parsed.data.reason,
  });

  logAudit({
    action: "EMAIL_SUPPRESSION_CLEARED",
    memberId: session.user.id,
    targetId: suppression.id,
    details: JSON.stringify({
      email: suppression.email,
      reason: parsed.data.reason ?? null,
    }),
  });

  return NextResponse.json({
    success: true,
    suppression: {
      id: suppression.id,
      email: suppression.email,
      clearedAt: suppression.clearedAt?.toISOString() ?? null,
    },
  });
}
