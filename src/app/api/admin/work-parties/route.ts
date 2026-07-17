import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { formatDateOnly } from "@/lib/date-only";
import {
  createWorkPartyEventWithPromo,
  workPartyEventDatesError,
  workPartyEventSchema,
} from "@/lib/work-party";

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const events = await prisma.workPartyEvent.findMany({
    include: {
      lodge: { select: { name: true } },
      promoCode: {
        select: {
          id: true,
          redemptions: { select: { discountCents: true } },
        },
      },
    },
    orderBy: { startDate: "desc" },
  });

  return NextResponse.json({
    events: events.map(({ promoCode, lodge, ...event }) => ({
      ...event,
      lodgeName: lodge?.name ?? null,
      bookingCount: promoCode.redemptions.length,
      totalDiscountCents: promoCode.redemptions.reduce(
        (sum, redemption) => sum + redemption.discountCents,
        0
      ),
    })),
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const json = await parseJsonRequestBody(req);
  if (!json.ok) return json.response;

  const parsed = workPartyEventSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const datesError = workPartyEventDatesError(parsed.data);
  if (datesError) {
    return NextResponse.json({ error: datesError }, { status: 400 });
  }

  if (parsed.data.lodgeId) {
    const lodge = await prisma.lodge.findUnique({
      where: { id: parsed.data.lodgeId },
      select: { active: true },
    });
    if (!lodge?.active) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 }
      );
    }
  }

  const event = await createWorkPartyEventWithPromo({
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    startDate: parsed.data.startDate,
    endDate: parsed.data.endDate,
    discountPercent: parsed.data.discountPercent,
    active: parsed.data.active,
    lodgeId: parsed.data.lodgeId ?? null,
  });

  logAudit({
    action: "workparty.create",
    memberId: session.user.id,
    targetId: event.id,
    entityType: "WorkPartyEvent",
    entityId: event.id,
    category: "admin",
    outcome: "success",
    summary: "Work party event created",
    details: `Created work party event: ${event.name}`,
    metadata: {
      name: event.name,
      startDate: formatDateOnly(event.startDate),
      endDate: formatDateOnly(event.endDate),
      discountPercent: event.discountPercent,
      active: event.active,
    },
  });

  return NextResponse.json({ event }, { status: 201 });
}
