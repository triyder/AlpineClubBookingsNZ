import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AgeTier } from "@prisma/client";
import { requireAdmin } from "@/lib/session-guards";
import {
  getJoiningFeePreviewForInputs,
  getJoiningFeePreviewForMember,
} from "@/lib/joining-fee";

const paramsSchema = z.object({ id: z.string().min(1) });

// Optional raw inputs for a not-yet-created applicant (E10 consumes this). When
// none are supplied, the preview resolves the member named in the route id.
const previewSchema = z
  .object({
    membershipTypeId: z.string().min(1).optional(),
    membershipTypeKey: z.string().min(1).optional(),
    ageTier: z.nativeEnum(AgeTier).nullable().optional(),
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Explicit permission gate (E1 pattern — never a bare requireAdmin): the
  // default amount exposes fee configuration, so it is read-gated on finance.
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  // Body is optional; an empty/absent body means "preview this member".
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) body = JSON.parse(text);
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

  const { membershipTypeId, membershipTypeKey, ageTier, dateOfBirth } = parsedBody.data;
  const hasRawInputs =
    membershipTypeId != null ||
    membershipTypeKey != null ||
    ageTier !== undefined ||
    dateOfBirth != null;

  const preview = hasRawInputs
    ? await getJoiningFeePreviewForInputs({
        membershipTypeId: membershipTypeId ?? null,
        membershipTypeKey: membershipTypeKey ?? null,
        ageTier: ageTier ?? null,
        dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00.000Z`) : null,
      })
    : await getJoiningFeePreviewForMember(parsedParams.data.id);

  return NextResponse.json(preview);
}
