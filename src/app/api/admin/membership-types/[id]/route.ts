import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  MEMBERSHIP_TYPE_BOOKING_BEHAVIORS,
  MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS,
  normalizeMembershipTypeText,
  serializeMembershipType,
} from "@/lib/membership-types";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const membershipTypeSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: true,
  subscriptionBehavior: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { assignments: true } },
} satisfies Prisma.MembershipTypeSelect;

const paramsSchema = z.object({
  id: z.string().min(1),
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    bookingBehavior: z.enum(MEMBERSHIP_TYPE_BOOKING_BEHAVIORS).optional(),
    subscriptionBehavior: z
      .enum(MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS)
      .optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

function auditActionForUpdate(
  before: { isActive: boolean },
  data: { isActive?: boolean },
) {
  if (data.isActive === false && before.isActive) {
    return {
      action: "MEMBERSHIP_TYPE_ARCHIVED",
      summary: "Membership type archived",
    };
  }
  if (data.isActive === true && !before.isActive) {
    return {
      action: "MEMBERSHIP_TYPE_REACTIVATED",
      summary: "Membership type reactivated",
    };
  }
  return {
    action: "MEMBERSHIP_TYPE_UPDATED",
    summary: "Membership type updated",
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json(
      { error: "At least one membership type field is required" },
      { status: 400 },
    );
  }

  const existing = await prisma.membershipType.findUnique({
    where: { id: parsedParams.data.id },
    select: membershipTypeSelect,
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Membership type not found" },
      { status: 404 },
    );
  }

  const data: Prisma.MembershipTypeUpdateInput = {};
  if (parsed.data.name !== undefined) {
    data.name = parsed.data.name.trim();
  }
  if (parsed.data.description !== undefined) {
    data.description = normalizeMembershipTypeText(parsed.data.description);
  }
  if (parsed.data.bookingBehavior !== undefined) {
    data.bookingBehavior = parsed.data.bookingBehavior;
  }
  if (parsed.data.subscriptionBehavior !== undefined) {
    data.subscriptionBehavior = parsed.data.subscriptionBehavior;
  }
  if (parsed.data.isActive !== undefined) {
    data.isActive = parsed.data.isActive;
  }
  if (parsed.data.sortOrder !== undefined) {
    data.sortOrder = parsed.data.sortOrder;
  }

  const auditAction = auditActionForUpdate(existing, parsed.data);
  const updated = await prisma.$transaction(async (tx) => {
    const membershipType = await tx.membershipType.update({
      where: { id: existing.id },
      data,
      select: membershipTypeSelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: auditAction.action,
        actor: { memberId: session.user.id },
        entity: { type: "MembershipType", id: existing.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: auditAction.summary,
        metadata: {
          changedFields: changedFields(existing, data as Record<string, unknown>),
          previousMembershipType: serializeMembershipType(existing),
          newMembershipType: serializeMembershipType(membershipType),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return membershipType;
  });

  return NextResponse.json({
    membershipType: serializeMembershipType(updated),
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.membershipType.findUnique({
    where: { id: parsedParams.data.id },
    select: membershipTypeSelect,
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Membership type not found" },
      { status: 404 },
    );
  }

  if (existing.isBuiltIn) {
    return NextResponse.json(
      { error: "Built-in membership types cannot be deleted" },
      { status: 409 },
    );
  }

  if ((existing._count?.assignments ?? 0) > 0) {
    return NextResponse.json(
      {
        error:
          "Membership types with seasonal assignments cannot be deleted. Archive the type instead.",
      },
      { status: 409 },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.membershipType.delete({ where: { id: existing.id } });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBERSHIP_TYPE_DELETED",
        actor: { memberId: session.user.id },
        entity: { type: "MembershipType", id: existing.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Membership type deleted",
        metadata: {
          previousMembershipType: serializeMembershipType(existing),
        },
        request: getAuditRequestContext(request),
      }),
    );
  });

  return NextResponse.json({ ok: true });
}
