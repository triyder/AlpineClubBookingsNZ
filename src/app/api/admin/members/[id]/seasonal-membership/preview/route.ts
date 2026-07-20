import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSeasonalMembershipChangePreview } from "@/lib/seasonal-membership-assignments";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const previewSchema = z
  .object({
    seasonYear: z.number().int().min(2020).max(2040),
    membershipTypeId: z.string().min(1),
    applyFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedBody = previewSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  const result = await getSeasonalMembershipChangePreview({
    memberId: parsedParams.data.id,
    seasonYear: parsedBody.data.seasonYear,
    membershipTypeId: parsedBody.data.membershipTypeId,
    applyFrom: parsedBody.data.applyFrom ?? null,
  });

  return NextResponse.json(result.body, result.init);
}
