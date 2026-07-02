import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  MEMBERSHIP_TYPE_BOOKING_BEHAVIORS,
  MEMBERSHIP_TYPE_AGE_TIERS,
  MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS,
  MEMBERSHIP_TYPE_XERO_RULE_MODES,
  buildUniqueMembershipTypeKey,
  membershipTypeOrderBy,
  normalizeMembershipTypeAgeTiers,
  normalizeMembershipTypeText,
  normalizeMembershipTypeXeroRules,
  replaceMembershipTypeRuleConfiguration,
  serializeMembershipType,
  validateMembershipTypeRuleConfiguration,
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
  allowedAgeTiers: {
    select: { ageTier: true },
    orderBy: { ageTier: "asc" },
  },
  xeroContactGroupRules: {
    select: {
      id: true,
      ageTier: true,
      mode: true,
      groupId: true,
      groupName: true,
      isActive: true,
      sortOrder: true,
    },
    orderBy: [{ sortOrder: "asc" }, { groupName: "asc" }, { groupId: "asc" }],
  },
  _count: { select: { assignments: true } },
} satisfies Prisma.MembershipTypeSelect;

const xeroRuleSchema = z
  .object({
    ageTier: z.enum(MEMBERSHIP_TYPE_AGE_TIERS).nullable().optional(),
    mode: z.enum(MEMBERSHIP_TYPE_XERO_RULE_MODES),
    groupId: z.string().trim().min(1).max(200),
    groupName: z.string().trim().max(200).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    bookingBehavior: z.enum(MEMBERSHIP_TYPE_BOOKING_BEHAVIORS),
    subscriptionBehavior: z.enum(MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    allowedAgeTiers: z.array(z.enum(MEMBERSHIP_TYPE_AGE_TIERS)).optional(),
    xeroContactGroupRules: z.array(xeroRuleSchema).optional(),
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

  // Reject duplicate display names (case-insensitive exact match) before the
  // key builder silently suffixes a unique key for the same visible name.
  const name = parsed.data.name.trim();
  const duplicate = await prisma.membershipType.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (duplicate) {
    return NextResponse.json(
      { error: `A membership type named "${duplicate.name}" already exists.` },
      { status: 409 },
    );
  }

  const key = await buildUniqueMembershipTypeKey(prisma, name);
  const lastType = await prisma.membershipType.findFirst({
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = parsed.data.sortOrder ?? (lastType?.sortOrder ?? -1) + 1;
  const data = {
    key,
    name,
    description: normalizeMembershipTypeText(parsed.data.description),
    isActive: parsed.data.isActive,
    isBuiltIn: false,
    bookingBehavior: parsed.data.bookingBehavior,
    subscriptionBehavior: parsed.data.subscriptionBehavior,
    sortOrder,
  };
  const allowedAgeTiers = normalizeMembershipTypeAgeTiers(
    parsed.data.allowedAgeTiers ?? MEMBERSHIP_TYPE_AGE_TIERS,
  );
  const xeroContactGroupRules = normalizeMembershipTypeXeroRules(
    parsed.data.xeroContactGroupRules ?? [],
  );
  const configurationError = validateMembershipTypeRuleConfiguration({
    allowedAgeTiers,
    xeroContactGroupRules,
  });
  if (configurationError) {
    return NextResponse.json({ error: configurationError }, { status: 400 });
  }

  const created = await prisma.$transaction(async (tx) => {
    const membershipType = await tx.membershipType.create({
      data,
      select: membershipTypeSelect,
    });
    await replaceMembershipTypeRuleConfiguration(tx, membershipType.id, {
      allowedAgeTiers,
      xeroContactGroupRules,
    });
    const membershipTypeWithRules = await tx.membershipType.findUniqueOrThrow({
      where: { id: membershipType.id },
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
        metadata: {
          newMembershipType: serializeMembershipType(membershipTypeWithRules),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return membershipTypeWithRules;
  });

  return NextResponse.json(
    {
      membershipType: serializeMembershipType(created),
    },
    { status: 201 },
  );
}
