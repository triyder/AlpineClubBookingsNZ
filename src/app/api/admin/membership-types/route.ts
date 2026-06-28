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
  buildUniqueMembershipTypeKey,
  membershipTypeOrderBy,
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

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    bookingBehavior: z.enum(MEMBERSHIP_TYPE_BOOKING_BEHAVIORS),
    subscriptionBehavior: z.enum(MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

async function loadMembershipTypes() {
  const membershipTypes = await prisma.membershipType.findMany({
    orderBy: membershipTypeOrderBy(),
    select: membershipTypeSelect,
  });

  return {
    membershipTypes: membershipTypes.map(serializeMembershipType),
  };
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  return NextResponse.json(await loadMembershipTypes());
}

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const key = await buildUniqueMembershipTypeKey(prisma, parsed.data.name);
  const lastType = await prisma.membershipType.findFirst({
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = parsed.data.sortOrder ?? (lastType?.sortOrder ?? -1) + 1;
  const data = {
    key,
    name: parsed.data.name.trim(),
    description: normalizeMembershipTypeText(parsed.data.description),
    isActive: parsed.data.isActive,
    isBuiltIn: false,
    bookingBehavior: parsed.data.bookingBehavior,
    subscriptionBehavior: parsed.data.subscriptionBehavior,
    sortOrder,
  };

  const created = await prisma.$transaction(async (tx) => {
    const membershipType = await tx.membershipType.create({
      data,
      select: membershipTypeSelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBERSHIP_TYPE_CREATED",
        actor: { memberId: session.user.id },
        entity: { type: "MembershipType", id: membershipType.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Membership type created",
        metadata: { newMembershipType: serializeMembershipType(membershipType) },
        request: getAuditRequestContext(request),
      }),
    );

    return membershipType;
  });

  return NextResponse.json(
    {
      membershipType: serializeMembershipType(created),
    },
    { status: 201 },
  );
}
