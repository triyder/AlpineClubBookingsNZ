import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getInductionById } from "@/lib/induction";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireActiveSession } from "@/lib/session-guards";

const SELF_ASSESSMENT_LEVELS = ["UNDERSTAND", "CAN_DO", "CAN_TEACH"] as const;

const selfAssessSchema = z.object({
  items: z.record(z.string(), z.enum(SELF_ASSESSMENT_LEVELS).nullable()),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = selfAssessSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const induction = await getInductionById(id);
  if (!induction) {
    return NextResponse.json({ error: "Induction not found" }, { status: 404 });
  }

  if (induction.memberId !== guard.session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (induction.status === "COMPLETED" || induction.status === "VOIDED") {
    return NextResponse.json(
      { error: "This induction is no longer open" },
      { status: 409 }
    );
  }

  try {
    await prisma.memberInduction.update({
      where: { id },
      data: {
        selfAssessmentJson: JSON.stringify(parsed.data.items),
        selfAssessedAt: new Date(),
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error({ err, inductionId: id }, "Failed to save self-assessment");
    return NextResponse.json(
      { error: "Failed to save self-assessment" },
      { status: 500 }
    );
  }
}
