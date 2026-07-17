import { NextRequest, NextResponse } from "next/server";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";

const groupDiscountSchema = z.object({
  minGroupSize: z.number().int().min(2).max(200),
  summerOnly: z.boolean(),
  enabled: z.boolean(),
});

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const setting = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });

  return NextResponse.json(
    setting || { id: "default", minGroupSize: 5, summerOnly: true, enabled: false }
  );
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await req.json();
  const parsed = groupDiscountSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const lodgeCapacity = await getDefaultLodgeCapacity();
  if (parsed.data.minGroupSize > lodgeCapacity) {
    return NextResponse.json(
      { error: `Minimum group size cannot exceed lodge capacity (${lodgeCapacity}).` },
      { status: 400 },
    );
  }

  // The substitution target a qualifying discount applies to true non-members
  // (#1930, E4). A row created here (post-migration) must not carry a NULL
  // target — that would leave the discount inert but for the read-time
  // fallback — so seed it to the built-in FULL type, exactly like the
  // migration backfill. An admin-configured non-null target is never
  // overwritten; an existing NULL is healed in place.
  const fullType = await prisma.membershipType.findFirst({
    where: { key: "FULL" },
    select: { id: true },
  });
  const result = await prisma.groupDiscountSetting.upsert({
    where: { id: "default" },
    update: parsed.data,
    create: {
      id: "default",
      ...parsed.data,
      rateMembershipTypeId: fullType?.id ?? null,
    },
  });
  if (result.rateMembershipTypeId === null && fullType) {
    const healed = await prisma.groupDiscountSetting.update({
      where: { id: "default" },
      data: { rateMembershipTypeId: fullType.id },
    });
    result.rateMembershipTypeId = healed.rateMembershipTypeId;
  }

  logAudit({
    action: "group-discount.update",
    memberId: session.user.id,
    details: `Group discount: minSize=${parsed.data.minGroupSize}, summerOnly=${parsed.data.summerOnly}, enabled=${parsed.data.enabled}`,
  });

  revalidatePublicPageContent();
  return NextResponse.json(result);
}
