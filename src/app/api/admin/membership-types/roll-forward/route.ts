import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuditRequestContext } from "@/lib/audit";
import { rollForwardSeasonalMembershipAssignments } from "@/lib/seasonal-membership-assignments";
import { requireAdmin } from "@/lib/session-guards";

const rollForwardSchema = z
  .object({
    fromSeasonYear: z.number().int().min(2020).max(2040),
    toSeasonYear: z.number().int().min(2020).max(2040),
    dryRun: z.boolean().optional().default(false),
  })
  .strict();

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedBody = rollForwardSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  const result = await rollForwardSeasonalMembershipAssignments({
    fromSeasonYear: parsedBody.data.fromSeasonYear,
    toSeasonYear: parsedBody.data.toSeasonYear,
    dryRun: parsedBody.data.dryRun,
    adminMemberId: guard.session.user.id,
    request: getAuditRequestContext(request),
  });

  return NextResponse.json(result.body, result.init);
}
