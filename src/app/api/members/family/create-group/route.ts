import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { getTodayDateOnly, parseDateOnly } from "@/lib/date-only";
import { getSeasonYear } from "@/lib/utils";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import {
  sendAdminFamilyGroupRequestAlert,
  sendGroupCreateRequestConfirmationEmail,
} from "@/lib/email";
import { nameField } from "@/lib/zod-helpers";

const createGroupSchema = z.object({
  groupName: z
    .string()
    .min(1, "Group name cannot be empty")
    .max(100, "Group name must be 100 characters or fewer")
    .optional(),
  partnerEmail: z.string().email("Invalid email address").optional(),
  children: z
    .array(
      z.object({
        firstName: nameField({ required: "First name required" }),
        lastName: nameField({ required: "Last name required" }),
        dateOfBirth: z
          .string({ error: "Date of birth is required" })
          .min(1, "Date of birth is required")
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be YYYY-MM-DD format"),
      })
    )
    .max(6, "A group creation request can include at most 6 infant/child/youth members")
    .default([]),
});

/**
 * POST /api/members/family/create-group (#1681)
 * A group-less adult member requests a brand-new family group: optional group
 * name, optional partner (must already be a registered member), optional
 * infant/child/youth members. The whole bundle goes to the admin queue:
 * a memberless FamilyGroup row plus a PENDING GROUP_CREATE request (and one
 * standard CHILD_REQUEST per child) are created up front; the requester's
 * ADMIN membership and the partner ADULT_INVITE are only created when an
 * admin approves the GROUP_CREATE request.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const rateLimited = await applyRateLimit(rateLimiters.familyGroupJoinRequest, req);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createGroupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const children = parsed.data.children ?? [];

  // Fetch requester — must be an active adult with a login account.
  const requester = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      active: true,
      canLogin: true,
      ageTier: true,
      familyGroupMemberships: { select: { familyGroupId: true }, take: 1 },
    },
  });

  if (!requester || !requester.active) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (!requester.canLogin) {
    return NextResponse.json(
      { error: "Only members with login accounts can create a family group" },
      { status: 403 }
    );
  }

  if (requester.ageTier !== "ADULT") {
    return NextResponse.json(
      { error: "Only adults can create a family group" },
      { status: 403 }
    );
  }

  if (requester.familyGroupMemberships.length > 0) {
    return NextResponse.json(
      {
        error:
          "You are already in a family group. Use the invite and request options on your existing group instead.",
      },
      { status: 422 }
    );
  }

  // One pending GROUP_CREATE per requester, and no simultaneous pending
  // JOIN_REQUEST — a member cannot both join and create a group at once.
  const conflictingRequest = await prisma.familyGroupJoinRequest.findFirst({
    where: {
      requesterId: session.user.id,
      status: "PENDING",
      type: { in: ["GROUP_CREATE", "JOIN_REQUEST"] },
    },
    select: { id: true, type: true },
  });

  if (conflictingRequest?.type === "GROUP_CREATE") {
    return NextResponse.json(
      {
        error:
          "You already have a pending family group creation request. Please wait for it to be reviewed.",
      },
      { status: 422 }
    );
  }
  if (conflictingRequest) {
    return NextResponse.json(
      {
        error:
          "You already have a pending join request. Please wait for it to be reviewed before creating a new family group.",
      },
      { status: 422 }
    );
  }

  // Resolve the optional partner using the invite route's registered/active/
  // canLogin/ADULT checks — token-based invites for unregistered partners are
  // a follow-up (#1682).
  let partner: { id: string; firstName: string; lastName: string } | null = null;
  const normalizedPartnerEmail = parsed.data.partnerEmail?.toLowerCase().trim() || null;
  if (normalizedPartnerEmail) {
    const target = await prisma.member.findFirst({
      where: {
        email: normalizedPartnerEmail,
        canLogin: true,
        active: true,
      },
      select: { id: true, firstName: true, lastName: true, ageTier: true },
    });

    if (!target) {
      return NextResponse.json(
        {
          error:
            "This person is not a registered member. They need to join through the membership process first. Contact admin if you believe they should be a member.",
        },
        { status: 404 }
      );
    }

    if (target.id === session.user.id) {
      return NextResponse.json({ error: "You cannot invite yourself" }, { status: 422 });
    }

    if (target.ageTier !== "ADULT") {
      return NextResponse.json(
        {
          error:
            "Only adults can be invited directly. For infants, children, or youth, use the 'Request to Add Infant/Child/Youth' option instead.",
        },
        { status: 422 }
      );
    }

    partner = { id: target.id, firstName: target.firstName, lastName: target.lastName };
  }

  // Per-child DOB sanity, mirroring request-child.
  const seasonStart = getSeasonStartDate(getSeasonYear());
  const today = getTodayDateOnly();
  const parsedChildren: Array<{ firstName: string; lastName: string; dateOfBirth: Date }> = [];
  for (const child of children) {
    const childDob = parseDateOnly(child.dateOfBirth);
    if (Number.isNaN(childDob.getTime())) {
      return NextResponse.json(
        { error: "Date of birth must be a real calendar date" },
        { status: 422 }
      );
    }
    if (childDob > today) {
      return NextResponse.json(
        { error: "Date of birth cannot be in the future" },
        { status: 422 }
      );
    }
    const childAgeTier = await computeAgeTier(childDob, seasonStart);
    if (childAgeTier === "ADULT") {
      return NextResponse.json(
        { error: "Use the same-email adult request flow for adult members" },
        { status: 422 }
      );
    }
    parsedChildren.push({
      firstName: child.firstName.trim(),
      lastName: child.lastName.trim(),
      dateOfBirth: childDob,
    });
  }

  // Reject duplicate child rows within the submission (case-insensitive
  // name + DOB, mirroring request-child's duplicate-pending check).
  const seenChildKeys = new Set<string>();
  for (const child of parsedChildren) {
    const childKey = [
      child.firstName.toLowerCase(),
      child.lastName.toLowerCase(),
      child.dateOfBirth.toISOString(),
    ].join("|");
    if (seenChildKeys.has(childKey)) {
      return NextResponse.json(
        {
          error: `A request for ${child.firstName} ${child.lastName} is already included in this submission. Remove the duplicate row.`,
        },
        { status: 422 }
      );
    }
    seenChildKeys.add(childKey);
  }

  const groupName = parsed.data.groupName?.trim() || `${requester.lastName} Family`;

  // One transaction: memberless FamilyGroup + GROUP_CREATE + N CHILD_REQUESTs.
  // The group has zero FamilyGroupMember rows until admin approval, which keeps
  // it invisible everywhere (memberships drive all eligibility and UI).
  // Explicit createdAt values keep the GROUP_CREATE row above its bundled
  // child requests in the admin queue's `createdAt asc` ordering — rows
  // created inside one transaction can otherwise share an identical timestamp.
  const submittedAt = new Date();
  const { group, createRequest, childRequests } = await prisma.$transaction(async (tx) => {
    const group = await tx.familyGroup.create({
      data: { name: groupName },
    });

    const createRequest = await tx.familyGroupJoinRequest.create({
      data: {
        familyGroupId: group.id,
        requesterId: session.user.id,
        type: "GROUP_CREATE",
        invitedMemberId: partner?.id ?? null,
        createdAt: submittedAt,
      },
    });

    const childRequests: Array<{ id: string }> = [];
    for (const [index, child] of parsedChildren.entries()) {
      childRequests.push(
        await tx.familyGroupJoinRequest.create({
          data: {
            familyGroupId: group.id,
            requesterId: session.user.id,
            type: "CHILD_REQUEST",
            childFirstName: child.firstName,
            childLastName: child.lastName,
            childDateOfBirth: child.dateOfBirth,
            createdAt: new Date(submittedAt.getTime() + index + 1),
          },
        })
      );
    }

    return { group, createRequest, childRequests };
  });

  const childRequestIds = childRequests.map((request) => request.id);

  logAudit({
    action: "FAMILY_GROUP_CREATE_REQUESTED",
    memberId: session.user.id,
    targetId: group.id,
    subjectMemberId: session.user.id,
    entityType: "FamilyGroupJoinRequest",
    entityId: createRequest.id,
    category: "family",
    outcome: "success",
    summary: "Family group creation requested",
    details: JSON.stringify({
      familyGroupId: group.id,
      groupName,
      partnerMemberId: partner?.id ?? null,
      childCount: parsedChildren.length,
      childRequestIds,
    }),
    metadata: {
      familyGroupId: group.id,
      groupName,
      partnerMemberId: partner?.id ?? null,
      childCount: parsedChildren.length,
      childRequestIds,
    },
  });

  logger.info(
    {
      requestId: createRequest.id,
      requesterId: session.user.id,
      familyGroupId: group.id,
      partnerMemberId: partner?.id ?? null,
      childCount: parsedChildren.length,
    },
    "Family group creation request submitted"
  );

  // Requester confirmation (fire-and-forget).
  sendGroupCreateRequestConfirmationEmail(
    requester.email,
    `${requester.firstName} ${requester.lastName}`,
    groupName
  ).catch((err) => {
    logger.error(
      { err, requestId: createRequest.id },
      "Failed to send group create request confirmation email"
    );
  });

  // Admin alert (fire-and-forget).
  const detailParts = [`Wants to create the family group "${groupName}"`];
  if (partner) {
    detailParts.push(`inviting ${partner.firstName} ${partner.lastName} on approval`);
  }
  if (parsedChildren.length > 0) {
    detailParts.push(
      `with ${parsedChildren.length} bundled infant/child/youth request${parsedChildren.length === 1 ? "" : "s"}`
    );
  }
  sendAdminFamilyGroupRequestAlert({
    requestType: "Group Create Request",
    requesterName: `${requester.firstName} ${requester.lastName}`,
    groupName,
    details: detailParts.join(", "),
  }).catch((err) => {
    logger.error(
      { err, requestId: createRequest.id },
      "Failed to send admin family group request alert"
    );
  });

  return NextResponse.json(
    {
      message: "Request submitted. An admin will review your new family group.",
      requestId: createRequest.id,
      familyGroupId: group.id,
      childRequestIds,
    },
    { status: 201 }
  );
}
