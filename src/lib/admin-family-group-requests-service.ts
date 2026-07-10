import { z } from "zod";
import { Prisma, type AgeTier } from "@prisma/client";
import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import {
  computeAgeTier,
  computeAgeTierWithSettings,
  getAgeTierSettings,
  getSeasonStartDate,
  type AgeTierSettingData,
} from "@/lib/age-tier";
import { getSeasonYear } from "@/lib/utils";
import {
  buildParentLinks,
  resolveParentNotificationSourceId,
} from "@/lib/member-parent-links";
import { validateInheritEmailSource } from "@/lib/member-email-inheritance";
import {
  sendChildRequestApprovedEmail,
  sendChildRequestRejectedEmail,
  sendFamilyGroupInvitationEmail,
  sendGroupCreateApprovedEmail,
  sendGroupCreateRejectedEmail,
} from "@/lib/email";

export const REVIEWED_REQUEST_TYPES = [
  "JOIN_REQUEST",
  "CHILD_REQUEST",
  "ADULT_REQUEST",
  "REMOVAL_REQUEST",
  "GROUP_CREATE",
] as const;

const CHILD_REQUEST_AGE_TIERS: AgeTier[] = ["INFANT", "CHILD", "YOUTH"];

class ReviewRequestError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 422 = 422
  ) {
    super(message);
  }
}

type JsonRouteResult = {
  body: unknown;
  init?: ResponseInit;
};

function cleanOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init };
}

export const reviewFamilyGroupRequestSchema = z.object({
  requestId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  linkedMemberId: z.string().min(1).optional(),
  // Empty string is intentionally allowed: the admin request-review UI's
  // "Use child's own email" option sends inheritEmailFromId: "" (its
  // <option value="">), which the approve path coerces to null (no inheritance,
  // child keeps its own email) via `data.inheritEmailFromId?.trim() || null` and
  // resolveParentNotificationSourceId. Do not tighten to reject "" without
  // updating that client — a rolling deploy would 422 the old client's requests.
  inheritEmailFromId: z.string().optional().nullable().or(z.literal("")),
  createNewMember: z.boolean().optional(),
  rejectionReason: z.string().max(500).optional(),
});

export type ReviewFamilyGroupRequestInput = z.infer<
  typeof reviewFamilyGroupRequestSchema
>;

function getSameDayRange(date: Date) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return { gte: start, lt: end };
}

function getRequestName(request: {
  type: string;
  childFirstName?: string | null;
  childLastName?: string | null;
  requestedFirstName?: string | null;
  requestedLastName?: string | null;
}) {
  if (request.type === "CHILD_REQUEST") {
    return [request.childFirstName, request.childLastName].filter(Boolean).join(" ").trim();
  }
  return [request.requestedFirstName, request.requestedLastName].filter(Boolean).join(" ").trim();
}

function getChildRequestTierMetadata(
  request: { type: string; childDateOfBirth?: Date | null },
  ageTierSettings: AgeTierSettingData[]
) {
  if (request.type !== "CHILD_REQUEST" || !request.childDateOfBirth) {
    return {
      requestedAgeTier: null,
      requestedAgeTierLabel: null,
      canCreateMemberFromRequest: false,
    };
  }

  const requestedAgeTier = computeAgeTierWithSettings(
    request.childDateOfBirth,
    getSeasonStartDate(getSeasonYear()),
    ageTierSettings
  );
  const setting = ageTierSettings.find((candidate) => candidate.tier === requestedAgeTier);

  return {
    requestedAgeTier,
    requestedAgeTierLabel: setting?.label ?? requestedAgeTier,
    canCreateMemberFromRequest:
      setting?.familyGroupRequestCreateMemberAllowed === true,
  };
}

async function findPotentialMemberMatches(request: {
  type: string;
  familyGroupId: string;
  childFirstName?: string | null;
  childLastName?: string | null;
  childDateOfBirth?: Date | null;
  requestedFirstName?: string | null;
  requestedLastName?: string | null;
  requestedDateOfBirth?: Date | null;
  requestedEmail?: string | null;
}) {
  if (request.type !== "CHILD_REQUEST" && request.type !== "ADULT_REQUEST") {
    return [];
  }

  const firstName =
    request.type === "CHILD_REQUEST"
      ? request.childFirstName
      : request.requestedFirstName;
  const lastName =
    request.type === "CHILD_REQUEST"
      ? request.childLastName
      : request.requestedLastName;
  const dateOfBirth =
    request.type === "CHILD_REQUEST"
      ? request.childDateOfBirth
      : request.requestedDateOfBirth;

  if (!firstName || !lastName) {
    return [];
  }

  const members = await prisma.member.findMany({
    where: {
      AND: [
        { firstName: { contains: firstName.trim(), mode: "insensitive" as const } },
        { lastName: { contains: lastName.trim(), mode: "insensitive" as const } },
        ...(dateOfBirth ? [{ dateOfBirth: getSameDayRange(dateOfBirth) }] : []),
        ...(request.type === "ADULT_REQUEST"
          ? [
              { ageTier: "ADULT" as AgeTier },
              { active: true },
              { archivedAt: null },
            ]
          : []),
        ...(request.type === "CHILD_REQUEST"
          ? [
              { ageTier: { in: CHILD_REQUEST_AGE_TIERS } },
              { active: true },
              { archivedAt: null },
            ]
          : []),
        ...(request.type === "ADULT_REQUEST" && request.requestedEmail
          ? [{ email: { equals: request.requestedEmail, mode: "insensitive" as const } }]
          : []),
      ],
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      ageTier: true,
      active: true,
      canLogin: true,
      parentMemberId: true,
      secondaryParentId: true,
      inheritEmailFromId: true,
      parent: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          active: true,
          canLogin: true,
          inheritEmailFromId: true,
        },
      },
      secondaryParent: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          active: true,
          canLogin: true,
          inheritEmailFromId: true,
        },
      },
      dateOfBirth: true,
      familyGroupMemberships: {
        where: { familyGroupId: request.familyGroupId },
        select: { familyGroupId: true },
      },
    },
    orderBy: [{ active: "desc" }, { lastName: "asc" }, { firstName: "asc" }],
    take: 10,
  });

  return members.map((member) => ({
    id: member.id,
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    ageTier: member.ageTier,
    active: member.active,
    canLogin: member.canLogin,
    dateOfBirth: member.dateOfBirth,
    parentLinks: buildParentLinks(member),
    alreadyInGroup: member.familyGroupMemberships.length > 0,
  }));
}

export async function listAdminFamilyGroupRequests(): Promise<JsonRouteResult> {
  const ageTierSettings = await getAgeTierSettings();
  const requests = await prisma.familyGroupJoinRequest.findMany({
    where: {
      status: "PENDING",
      type: { in: [...REVIEWED_REQUEST_TYPES] },
    },
    include: {
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      subjectMember: {
        select: { id: true, firstName: true, lastName: true, email: true, ageTier: true, active: true },
      },
      invitedMember: {
        select: { id: true, firstName: true, lastName: true, email: true, ageTier: true, active: true },
      },
      familyGroup: {
        select: {
          id: true,
          name: true,
          memberships: {
            where: { member: { active: true, archivedAt: null } },
            select: {
              member: {
                select: { id: true, firstName: true, lastName: true, email: true, ageTier: true },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const mapped = await Promise.all(
    requests.map(async (request) => ({
      ...request,
      ...getChildRequestTierMetadata(request, ageTierSettings),
      familyGroup: {
        ...request.familyGroup,
        members: request.familyGroup.memberships.map((membership) => membership.member),
        memberships: undefined,
      },
      matchingMembers: await findPotentialMemberMatches(request),
    }))
  );

  return jsonResult({ requests: mapped });
}

async function validateLinkedMemberForRequest(params: {
  linkedMemberId: string;
  requestType: string;
}) {
  const linkedMember = await prisma.member.findUnique({
    where: { id: params.linkedMemberId },
    select: {
      id: true,
      ageTier: true,
      active: true,
      archivedAt: true,
      canLogin: true,
      parentMemberId: true,
      secondaryParentId: true,
      inheritEmailFromId: true,
      parent: { select: { id: true, inheritEmailFromId: true } },
      secondaryParent: { select: { id: true, inheritEmailFromId: true } },
      dependents: { select: { id: true }, take: 1 },
      secondaryDependents: { select: { id: true }, take: 1 },
    },
  });

  if (!linkedMember) {
    return { error: "Selected member record not found", status: 404 as const };
  }
  if (params.requestType === "CHILD_REQUEST") {
    if (
      !linkedMember.active ||
      linkedMember.archivedAt ||
      !CHILD_REQUEST_AGE_TIERS.includes(linkedMember.ageTier)
    ) {
      return {
        error: "Selected member must be an active infant, child, or youth",
        status: 422 as const,
      };
    }
  }
  if (params.requestType === "ADULT_REQUEST") {
    if (!linkedMember.active || linkedMember.archivedAt || linkedMember.ageTier !== "ADULT") {
      return { error: "Selected member must be an active adult", status: 422 as const };
    }
    if (linkedMember.canLogin) {
      return {
        error: "Same-email adult requests must link to a non-login adult member",
        status: 422 as const,
      };
    }
  }

  return { memberId: linkedMember.id, member: linkedMember };
}

export async function reviewAdminFamilyGroupRequest(params: {
  adminMemberId: string;
  data: ReviewFamilyGroupRequestInput;
}): Promise<JsonRouteResult> {
  const { adminMemberId, data } = params;
  const { requestId, action } = data;
  const linkedMemberId = data.linkedMemberId?.trim();
  const rejectionReason = data.rejectionReason?.trim();

  const request = await prisma.familyGroupJoinRequest.findUnique({
    where: { id: requestId },
    include: {
      requester: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          active: true,
          archivedAt: true,
          inheritEmailFromId: true,
          phoneCountryCode: true,
          phoneAreaCode: true,
          phoneNumber: true,
          streetAddressLine1: true,
          streetAddressLine2: true,
          streetCity: true,
          streetRegion: true,
          streetPostalCode: true,
          streetCountry: true,
          postalAddressLine1: true,
          postalAddressLine2: true,
          postalCity: true,
          postalRegion: true,
          postalPostalCode: true,
          postalCountry: true,
        },
      },
      familyGroup: { select: { id: true, name: true } },
      subjectMember: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!request) {
    return jsonResult({ error: "Request not found" }, { status: 404 });
  }

  if (request.status !== "PENDING") {
    return jsonResult({ error: "Request has already been reviewed" }, { status: 422 });
  }

  if (request.type === "ADULT_INVITE") {
    return jsonResult(
      { error: "Adult invitations are managed by the invited member, not admin review." },
      { status: 422 }
    );
  }

  if (request.type === "GROUP_CREATE") {
    return reviewGroupCreateRequest({
      adminMemberId,
      action,
      rejectionReason,
      request: {
        id: request.id,
        familyGroupId: request.familyGroupId,
        requesterId: request.requesterId,
        invitedMemberId: request.invitedMemberId,
        requester: request.requester,
        familyGroup: request.familyGroup,
      },
    });
  }

  if (action === "approve") {
    let affectedMemberId = request.requesterId;
    let childMemberCreateData: {
      email: string;
      firstName: string;
      lastName: string;
      dateOfBirth: Date;
      ageTier: AgeTier;
      active: true;
      canLogin: false;
      role: "USER";
      parentMemberId: string;
      inheritParentEmail: true;
      inheritEmailFromId: string;
      passwordHash: string;
      emailVerified: true;
      phoneCountryCode: string | null;
      phoneAreaCode: string | null;
      phoneNumber: string | null;
      streetAddressLine1: string | null;
      streetAddressLine2: string | null;
      streetCity: string | null;
      streetRegion: string | null;
      streetPostalCode: string | null;
      streetCountry: string | null;
      postalAddressLine1: string | null;
      postalAddressLine2: string | null;
      postalCity: string | null;
      postalRegion: string | null;
      postalPostalCode: string | null;
      postalCountry: string | null;
    } | null = null;
    let adultMemberCreateData: {
      email: string;
      firstName: string;
      lastName: string;
      dateOfBirth: Date;
      ageTier: AgeTier;
      active: true;
      canLogin: false;
      passwordHash: string;
      emailVerified: true;
    } | null = null;
    let childMemberForParentLink: {
      id: string;
      parentMemberId: string | null;
      secondaryParentId: string | null;
      inheritEmailFromId: string | null;
      parent: { id: string; inheritEmailFromId: string | null } | null;
      secondaryParent: { id: string; inheritEmailFromId: string | null } | null;
      dependents: Array<{ id: string }>;
      secondaryDependents: Array<{ id: string }>;
    } | null = null;

    if (request.type === "CHILD_REQUEST") {
      // A CHILD_REQUEST bundled with a GROUP_CREATE targets a group that has
      // no memberships until the group creation request itself is approved.
      // Approving the child first would attach a dependant to a group with no
      // adult admin, so the group creation request must be approved first.
      // A legacy group emptied by removals gets the same 422 but actionable
      // copy (there is no group creation request to approve).
      const groupMembershipCount = await prisma.familyGroupMember.count({
        where: { familyGroupId: request.familyGroupId },
      });
      if (groupMembershipCount === 0) {
        const pendingGroupCreate = await prisma.familyGroupJoinRequest.findFirst({
          where: {
            familyGroupId: request.familyGroupId,
            type: "GROUP_CREATE",
            status: "PENDING",
          },
          select: { id: true },
        });
        return jsonResult(
          {
            error: pendingGroupCreate
              ? "Approve the group creation request for this family group first."
              : "This family group has no members; reject this request or re-establish the group first.",
          },
          { status: 422 }
        );
      }

      if (linkedMemberId && data.createNewMember) {
        return jsonResult(
          { error: "Choose an existing child member or create a new dependant, not both." },
          { status: 422 }
        );
      }

      if (data.createNewMember) {
        if (
          request.requester.active === false ||
          request.requester.archivedAt ||
          request.requester.ageTier !== "ADULT"
        ) {
          return jsonResult(
            { error: "Child requests can only be approved for active adult requesters." },
            { status: 422 }
          );
        }
        if (!request.childFirstName || !request.childLastName || !request.childDateOfBirth) {
          return jsonResult(
            { error: "Legacy child requests without DOB must link to an existing member or be rejected." },
            { status: 422 }
          );
        }

        const ageTierSettings = await getAgeTierSettings();
        const childRequestTier = getChildRequestTierMetadata(request, ageTierSettings);
        if (
          !childRequestTier.requestedAgeTier ||
          !childRequestTier.canCreateMemberFromRequest
        ) {
          return jsonResult(
            {
              error:
                "This age tier is not configured to allow admin-created members from family group requests. Link an existing member or reject the request.",
            },
            { status: 422 }
          );
        }

        const inheritEmailFromId =
          request.requester.inheritEmailFromId || request.requesterId;
        const validation = await validateInheritEmailSource({ inheritEmailFromId });
        if (!validation.ok) {
          return jsonResult({ error: validation.error }, { status: validation.status });
        }

        childMemberCreateData = {
          email: request.requester.email.toLowerCase().trim(),
          firstName: request.childFirstName.trim(),
          lastName: request.childLastName.trim(),
          dateOfBirth: request.childDateOfBirth,
          ageTier: childRequestTier.requestedAgeTier,
          active: true,
          canLogin: false,
          role: "USER",
          parentMemberId: request.requesterId,
          inheritParentEmail: true,
          inheritEmailFromId,
          passwordHash: await hash(randomBytes(32).toString("hex"), 13),
          emailVerified: true,
          phoneCountryCode: cleanOptionalString(request.requester.phoneCountryCode),
          phoneAreaCode: cleanOptionalString(request.requester.phoneAreaCode),
          phoneNumber: cleanOptionalString(request.requester.phoneNumber),
          streetAddressLine1: cleanOptionalString(request.requester.streetAddressLine1),
          streetAddressLine2: cleanOptionalString(request.requester.streetAddressLine2),
          streetCity: cleanOptionalString(request.requester.streetCity),
          streetRegion: cleanOptionalString(request.requester.streetRegion),
          streetPostalCode: cleanOptionalString(request.requester.streetPostalCode),
          streetCountry: cleanOptionalString(request.requester.streetCountry),
          postalAddressLine1: cleanOptionalString(request.requester.postalAddressLine1),
          postalAddressLine2: cleanOptionalString(request.requester.postalAddressLine2),
          postalCity: cleanOptionalString(request.requester.postalCity),
          postalRegion: cleanOptionalString(request.requester.postalRegion),
          postalPostalCode: cleanOptionalString(request.requester.postalPostalCode),
          postalCountry: cleanOptionalString(request.requester.postalCountry),
        };
      } else if (!linkedMemberId) {
        return jsonResult(
          { error: "Select the member record to link before approving this infant/child/youth request." },
          { status: 422 }
        );
      } else {
        const linked = await validateLinkedMemberForRequest({
          linkedMemberId,
          requestType: request.type,
        });
        if ("error" in linked) {
          return jsonResult({ error: linked.error }, { status: linked.status });
        }
        affectedMemberId = linked.memberId;
        childMemberForParentLink = linked.member;
      }
    }

    if (request.type === "ADULT_REQUEST") {
      if (linkedMemberId && data.createNewMember) {
        return jsonResult(
          { error: "Choose an existing member or create a new member, not both." },
          { status: 422 }
        );
      }

      if (linkedMemberId) {
        const linked = await validateLinkedMemberForRequest({
          linkedMemberId,
          requestType: request.type,
        });
        if ("error" in linked) {
          return jsonResult({ error: linked.error }, { status: linked.status });
        }
        affectedMemberId = linked.memberId;
      } else if (data.createNewMember) {
        if (
          !request.requestedFirstName ||
          !request.requestedLastName ||
          !request.requestedDateOfBirth ||
          !request.requestedEmail
        ) {
          return jsonResult(
            { error: "Adult request is missing required member details." },
            { status: 422 }
          );
        }

        const ageTier = await computeAgeTier(
          request.requestedDateOfBirth,
          getSeasonStartDate(getSeasonYear())
        );
        if (ageTier !== "ADULT") {
          return jsonResult(
            { error: "Requested member is not an adult for the current season." },
            { status: 422 }
          );
        }

        adultMemberCreateData = {
          email: request.requestedEmail.toLowerCase().trim(),
          firstName: request.requestedFirstName.trim(),
          lastName: request.requestedLastName.trim(),
          dateOfBirth: request.requestedDateOfBirth,
          ageTier,
          active: true,
          canLogin: false,
          passwordHash: await hash(randomBytes(32).toString("hex"), 13),
          emailVerified: true,
        };
      } else {
        return jsonResult(
          { error: "Select an existing adult member or choose to create a new non-login adult." },
          { status: 422 }
        );
      }
    }

    if (request.type === "REMOVAL_REQUEST") {
      if (!request.subjectMemberId) {
        return jsonResult(
          { error: "Removal request is missing the member to remove." },
          { status: 422 }
        );
      }
      affectedMemberId = request.subjectMemberId;
    }

    try {
      await prisma.$transaction(async (tx) => {
        if (childMemberCreateData) {
          const created = await tx.member.create({
            data: childMemberCreateData,
            select: { id: true },
          });
          affectedMemberId = created.id;
        }

        if (adultMemberCreateData) {
          const created = await tx.member.create({
            data: adultMemberCreateData,
            select: { id: true },
          });
          affectedMemberId = created.id;
        }

        if (request.type === "CHILD_REQUEST" && childMemberForParentLink) {
          if (
            request.requester.active === false ||
            request.requester.archivedAt ||
            (request.requester.ageTier && request.requester.ageTier !== "ADULT")
          ) {
            throw new ReviewRequestError("Child requests can only be approved for active adult requesters.");
          }
          if (
            (childMemberForParentLink.dependents?.length ?? 0) > 0 ||
            (childMemberForParentLink.secondaryDependents?.length ?? 0) > 0
          ) {
            throw new ReviewRequestError("Selected child member already has dependants.");
          }

          const requesterAlreadyLinked =
            childMemberForParentLink.parentMemberId === request.requesterId ||
            childMemberForParentLink.secondaryParentId === request.requesterId;
          const linkAsSecondary =
            Boolean(childMemberForParentLink.parentMemberId) &&
            childMemberForParentLink.parentMemberId !== request.requesterId;
          if (
            !requesterAlreadyLinked &&
            childMemberForParentLink.parentMemberId &&
            childMemberForParentLink.secondaryParentId
          ) {
            throw new ReviewRequestError("Selected child member already has two parents linked.");
          }

          const parentLinksAfterSave = [
            ...(childMemberForParentLink.parent
              ? [childMemberForParentLink.parent]
              : []),
            ...(childMemberForParentLink.secondaryParent
              ? [childMemberForParentLink.secondaryParent]
              : []),
            {
              id: request.requesterId,
              inheritEmailFromId: request.requester.inheritEmailFromId,
            },
          ];
          const explicitInheritEmailFromId =
            Object.prototype.hasOwnProperty.call(data, "inheritEmailFromId")
              ? data.inheritEmailFromId?.trim() || null
              : request.requesterId;
          const resolvedInheritEmailFromId = resolveParentNotificationSourceId(
            parentLinksAfterSave,
            explicitInheritEmailFromId
          );
          if (resolvedInheritEmailFromId === undefined && explicitInheritEmailFromId) {
            throw new ReviewRequestError("Notification email recipient must be one of the linked parents.");
          }
          if (resolvedInheritEmailFromId) {
            const validation = await validateInheritEmailSource(
              {
                memberId: childMemberForParentLink.id,
                inheritEmailFromId: resolvedInheritEmailFromId,
              },
              tx
            );
            if (!validation.ok) {
              throw new ReviewRequestError(validation.error, validation.status);
            }
          }

          await tx.member.update({
            where: { id: childMemberForParentLink.id },
            data: {
              ...(!requesterAlreadyLinked
                ? linkAsSecondary
                  ? { secondaryParent: { connect: { id: request.requesterId } } }
                  : { parent: { connect: { id: request.requesterId } } }
                : {}),
              inheritParentEmail: Boolean(resolvedInheritEmailFromId),
              inheritEmailFrom: resolvedInheritEmailFromId
                ? { connect: { id: resolvedInheritEmailFromId } }
                : { disconnect: true },
            },
          });
        }

        if (request.type === "REMOVAL_REQUEST") {
          await tx.familyGroupMember.deleteMany({
            where: {
              familyGroupId: request.familyGroupId,
              memberId: affectedMemberId,
            },
          });
        } else {
          await tx.familyGroupMember.upsert({
            where: {
              familyGroupId_memberId: {
                familyGroupId: request.familyGroupId,
                memberId: affectedMemberId,
              },
            },
            create: {
              familyGroupId: request.familyGroupId,
              memberId: affectedMemberId,
              role: "MEMBER",
            },
            update: {},
          });
        }

        await tx.familyGroupJoinRequest.update({
          where: { id: requestId },
          data: {
            status: "APPROVED",
            reviewedAt: new Date(),
            reviewedBy: adminMemberId,
            ...(request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST"
              ? { linkedMemberId: affectedMemberId }
              : {}),
          },
        });
      });
    } catch (error) {
      if (error instanceof ReviewRequestError) {
        return jsonResult({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const auditAction =
      request.type === "CHILD_REQUEST"
        ? "FAMILY_GROUP_CHILD_REQUEST_APPROVED"
        : request.type === "ADULT_REQUEST"
          ? "FAMILY_GROUP_ADULT_REQUEST_APPROVED"
          : request.type === "REMOVAL_REQUEST"
            ? "FAMILY_GROUP_REMOVAL_REQUEST_APPROVED"
            : "FAMILY_GROUP_JOIN_APPROVED";

    logAudit({
      action: auditAction,
      memberId: adminMemberId,
      targetId: affectedMemberId,
      subjectMemberId: affectedMemberId,
      entityType: "FamilyGroupJoinRequest",
      entityId: requestId,
      category: "family",
      outcome: "success",
      summary: "Family group request approved",
      details: JSON.stringify({
        familyGroupId: request.familyGroupId,
        requestId,
        requestType: request.type,
        linkedMemberId:
          request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST"
            ? affectedMemberId
            : undefined,
      }),
      metadata: {
        familyGroupId: request.familyGroupId,
        requestType: request.type,
        linkedMemberId:
          request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST"
            ? affectedMemberId
            : null,
      },
    });

    logger.info(
      {
        requestId,
        requesterId: request.requesterId,
        familyGroupId: request.familyGroupId,
        requestType: request.type,
        affectedMemberId,
      },
      "Family group request approved"
    );

    if (request.type === "CHILD_REQUEST" && request.requester) {
      const childName = getRequestName(request);
      sendChildRequestApprovedEmail(
        request.requester.email,
        request.requester.firstName,
        childName || "your child",
        request.familyGroup?.name ?? "your family group"
      ).catch((err) => {
        logger.error({ err, requestId }, "Failed to send child request approved email");
      });
    }
  } else {
    await prisma.familyGroupJoinRequest.update({
      where: { id: requestId },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedBy: adminMemberId,
      },
    });

    const auditAction =
      request.type === "CHILD_REQUEST"
        ? "FAMILY_GROUP_CHILD_REQUEST_REJECTED"
        : request.type === "ADULT_REQUEST"
          ? "FAMILY_GROUP_ADULT_REQUEST_REJECTED"
          : request.type === "REMOVAL_REQUEST"
            ? "FAMILY_GROUP_REMOVAL_REQUEST_REJECTED"
            : "FAMILY_GROUP_JOIN_REJECTED";

    logAudit({
      action: auditAction,
      memberId: adminMemberId,
      targetId: request.subjectMemberId ?? request.requesterId,
      subjectMemberId: request.subjectMemberId ?? request.requesterId,
      entityType: "FamilyGroupJoinRequest",
      entityId: requestId,
      category: "family",
      outcome: "success",
      summary: "Family group request rejected",
      details: JSON.stringify({
        familyGroupId: request.familyGroupId,
        requestId,
        requestType: request.type,
        rejectionReason: rejectionReason || undefined,
      }),
      metadata: {
        familyGroupId: request.familyGroupId,
        requestType: request.type,
        rejectionReason: rejectionReason || null,
      },
    });

    logger.info(
      { requestId, requesterId: request.requesterId, requestType: request.type },
      "Family group request rejected"
    );

    if (request.type === "CHILD_REQUEST" && request.requester) {
      const childName = getRequestName(request);
      sendChildRequestRejectedEmail(
        request.requester.email,
        request.requester.firstName,
        childName || "your child",
        rejectionReason || undefined
      ).catch((err) => {
        logger.error({ err, requestId }, "Failed to send child request rejected email");
      });
    }
  }

  return jsonResult({ success: true, action });
}

/**
 * Review a member-initiated "create family group from scratch" request
 * (#1681). The group row already exists but is memberless; approval creates
 * the requester's ADMIN membership and auto-files the partner ADULT_INVITE,
 * rejection cascade-rejects the bundled pending CHILD_REQUESTs and leaves the
 * memberless group row inert (deleting it would cascade away the request
 * history — see docs/DOMAIN_INVARIANTS.md).
 */
async function reviewGroupCreateRequest(params: {
  adminMemberId: string;
  action: "approve" | "reject";
  rejectionReason?: string;
  request: {
    id: string;
    familyGroupId: string;
    requesterId: string;
    invitedMemberId: string | null;
    requester: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      ageTier: AgeTier | null;
      active: boolean;
      archivedAt: Date | null;
    };
    familyGroup: { id: string; name: string | null } | null;
  };
}): Promise<JsonRouteResult> {
  const { adminMemberId, action, rejectionReason, request } = params;
  const requestId = request.id;
  const groupName = request.familyGroup?.name ?? "Unnamed Group";
  const requesterName =
    `${request.requester.firstName} ${request.requester.lastName}`.trim();

  if (action === "approve") {
    if (
      !request.requester.active ||
      request.requester.archivedAt ||
      request.requester.ageTier !== "ADULT"
    ) {
      return jsonResult(
        { error: "Group creation requests can only be approved for active adult requesters." },
        { status: 422 }
      );
    }

    // The requester must still be group-less: they may have accepted an
    // unrelated invitation (or been added by an admin) since submitting.
    const existingMembership = await prisma.familyGroupMember.findFirst({
      where: { memberId: request.requesterId },
      select: { familyGroupId: true },
    });
    if (existingMembership) {
      return jsonResult(
        {
          error:
            "The requester has joined a family group since submitting this request. Reject this group creation request instead.",
        },
        { status: 422 }
      );
    }

    // Re-check partner eligibility at approval time; if the partner became
    // ineligible, skip the invite (audited) without blocking group approval.
    let partner: { id: string; firstName: string; lastName: string; email: string } | null = null;
    let partnerInviteSkippedReason: string | null = null;
    if (request.invitedMemberId) {
      const candidate = await prisma.member.findUnique({
        where: { id: request.invitedMemberId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          active: true,
          archivedAt: true,
          canLogin: true,
          ageTier: true,
          familyGroupMemberships: {
            where: { familyGroupId: request.familyGroupId },
            select: { familyGroupId: true },
          },
        },
      });
      if (!candidate || !candidate.active || candidate.archivedAt) {
        partnerInviteSkippedReason = "partner_not_active";
      } else if (!candidate.canLogin) {
        partnerInviteSkippedReason = "partner_cannot_login";
      } else if (candidate.ageTier !== "ADULT") {
        partnerInviteSkippedReason = "partner_not_adult";
      } else if (candidate.familyGroupMemberships.length > 0) {
        partnerInviteSkippedReason = "partner_already_in_group";
      } else {
        const pendingInvite = await prisma.familyGroupJoinRequest.findFirst({
          where: {
            familyGroupId: request.familyGroupId,
            invitedMemberId: candidate.id,
            type: "ADULT_INVITE",
            status: "PENDING",
          },
          select: { id: true },
        });
        if (pendingInvite) {
          partnerInviteSkippedReason = "invite_already_pending";
        } else {
          partner = candidate;
        }
      }
    }

    let invitationId: string | null = null;
    try {
      await prisma.$transaction(async (tx) => {
        // GROUP_CREATE approval must create the requester's membership with
        // role ADMIN — do NOT route this through the generic member upsert
        // used by the other request types, which creates role MEMBER and
        // would leave the new group without a group admin.
        await tx.familyGroupMember.create({
          data: {
            familyGroupId: request.familyGroupId,
            memberId: request.requesterId,
            role: "ADMIN",
          },
        });

        await tx.familyGroupJoinRequest.update({
          where: { id: requestId },
          data: {
            status: "APPROVED",
            reviewedAt: new Date(),
            reviewedBy: adminMemberId,
          },
        });

        if (partner) {
          const invitation = await tx.familyGroupJoinRequest.create({
            data: {
              familyGroupId: request.familyGroupId,
              requesterId: request.requesterId,
              type: "ADULT_INVITE",
              invitedMemberId: partner.id,
            },
            select: { id: true },
          });
          invitationId = invitation.id;
        }
      });
    } catch (error) {
      // Concurrent double-approve: a second admin's membership create hits
      // the (familyGroupId, memberId) unique constraint after the first
      // admin's transaction committed. State is already correct (first admin
      // won), so surface a normal review error instead of a 500.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return jsonResult(
          {
            error:
              "The requester already has a membership in this family group — this request has likely just been approved by another admin.",
          },
          { status: 422 }
        );
      }
      throw error;
    }

    logAudit({
      action: "FAMILY_GROUP_CREATE_APPROVED",
      memberId: adminMemberId,
      targetId: request.familyGroupId,
      subjectMemberId: request.requesterId,
      entityType: "FamilyGroupJoinRequest",
      entityId: requestId,
      category: "family",
      outcome: "success",
      summary: "Family group creation request approved",
      details: JSON.stringify({
        familyGroupId: request.familyGroupId,
        requestId,
        requestType: "GROUP_CREATE",
        partnerMemberId: request.invitedMemberId,
        partnerInviteSkipped: Boolean(request.invitedMemberId && !invitationId),
        partnerInviteSkippedReason,
        invitationId,
      }),
      metadata: {
        familyGroupId: request.familyGroupId,
        requestType: "GROUP_CREATE",
        partnerMemberId: request.invitedMemberId,
        partnerInviteSkipped: Boolean(request.invitedMemberId && !invitationId),
        partnerInviteSkippedReason,
        invitationId,
      },
    });

    if (partner && invitationId) {
      logAudit({
        action: "FAMILY_GROUP_INVITE_SENT",
        memberId: adminMemberId,
        targetId: request.familyGroupId,
        subjectMemberId: partner.id,
        entityType: "FamilyGroupJoinRequest",
        entityId: invitationId,
        category: "family",
        outcome: "success",
        summary: "Family group invitation sent",
        details: JSON.stringify({
          invitedEmail: partner.email.toLowerCase(),
          invitedMemberId: partner.id,
          autoFiledByGroupCreateApproval: true,
        }),
        metadata: {
          familyGroupId: request.familyGroupId,
          invitedEmail: partner.email.toLowerCase(),
          invitedMemberId: partner.id,
          autoFiledByGroupCreateApproval: true,
        },
      });

      sendFamilyGroupInvitationEmail(
        partner.email.toLowerCase(),
        requesterName,
        groupName
      ).catch((err) => {
        logger.error(
          { err, requestId, invitationId },
          "Failed to send family group invitation email"
        );
      });
    }

    sendGroupCreateApprovedEmail(
      request.requester.email,
      request.requester.firstName,
      groupName
    ).catch((err) => {
      logger.error({ err, requestId }, "Failed to send group create approved email");
    });

    logger.info(
      {
        requestId,
        requesterId: request.requesterId,
        familyGroupId: request.familyGroupId,
        requestType: "GROUP_CREATE",
        invitationId,
        partnerInviteSkippedReason,
      },
      "Family group creation request approved"
    );

    return jsonResult({ success: true, action });
  }

  // Reject: cascade-reject the bundled pending child requests and keep the
  // memberless FamilyGroup row (deleting it would cascade-delete the request
  // history; a memberless group is inert, matching the request-join leftover
  // precedent). Any outstanding partner-invite token for this group (an
  // unregistered-partner invite, #1682) is revoked in the same transaction so a
  // rejected group cannot still be joined for the token's 30-day lifetime; a
  // claimed token (confirmedAt set) is left untouched.
  let cascadeRejectedChildRequestIds: string[] = [];
  let revokedPartnerInviteTokens: Array<{ id: string; invitedEmail: string }> = [];
  await prisma.$transaction(async (tx) => {
    await tx.familyGroupJoinRequest.update({
      where: { id: requestId },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedBy: adminMemberId,
      },
    });

    const siblingChildRequests = await tx.familyGroupJoinRequest.findMany({
      where: {
        familyGroupId: request.familyGroupId,
        requesterId: request.requesterId,
        type: "CHILD_REQUEST",
        status: "PENDING",
      },
      select: { id: true },
    });
    cascadeRejectedChildRequestIds = siblingChildRequests.map(
      (sibling: { id: string }) => sibling.id
    );
    if (cascadeRejectedChildRequestIds.length > 0) {
      await tx.familyGroupJoinRequest.updateMany({
        where: { id: { in: cascadeRejectedChildRequestIds } },
        data: {
          status: "REJECTED",
          reviewedAt: new Date(),
          reviewedBy: adminMemberId,
        },
      });
    }

    const outstandingTokens = await tx.partnerInviteToken.findMany({
      where: { familyGroupId: request.familyGroupId, confirmedAt: null },
      select: { id: true, invitedEmail: true },
    });
    revokedPartnerInviteTokens = outstandingTokens;
    if (outstandingTokens.length > 0) {
      await tx.partnerInviteToken.deleteMany({
        where: { familyGroupId: request.familyGroupId, confirmedAt: null },
      });
    }
  });

  for (const revoked of revokedPartnerInviteTokens) {
    logAudit({
      action: "FAMILY_GROUP_PARTNER_INVITE_REVOKED",
      memberId: adminMemberId,
      targetId: request.familyGroupId,
      entityType: "PartnerInviteToken",
      entityId: revoked.id,
      category: "family",
      outcome: "success",
      summary: "Partner invitation revoked",
      details: JSON.stringify({
        familyGroupId: request.familyGroupId,
        invitedEmail: revoked.invitedEmail,
        cause: "group_create_rejected",
      }),
      metadata: {
        familyGroupId: request.familyGroupId,
        invitedEmail: revoked.invitedEmail,
        cause: "group_create_rejected",
      },
    });
  }

  logAudit({
    action: "FAMILY_GROUP_CREATE_REJECTED",
    memberId: adminMemberId,
    targetId: request.familyGroupId,
    subjectMemberId: request.requesterId,
    entityType: "FamilyGroupJoinRequest",
    entityId: requestId,
    category: "family",
    outcome: "success",
    summary: "Family group creation request rejected",
    details: JSON.stringify({
      familyGroupId: request.familyGroupId,
      requestId,
      requestType: "GROUP_CREATE",
      rejectionReason: rejectionReason || undefined,
      cascadeRejectedChildRequestIds,
      revokedPartnerInviteTokenIds: revokedPartnerInviteTokens.map((t) => t.id),
    }),
    metadata: {
      familyGroupId: request.familyGroupId,
      requestType: "GROUP_CREATE",
      rejectionReason: rejectionReason || null,
      cascadeRejectedChildRequestIds,
      revokedPartnerInviteTokenIds: revokedPartnerInviteTokens.map((t) => t.id),
    },
  });

  sendGroupCreateRejectedEmail(
    request.requester.email,
    request.requester.firstName,
    groupName,
    rejectionReason || undefined
  ).catch((err) => {
    logger.error({ err, requestId }, "Failed to send group create rejected email");
  });

  logger.info(
    {
      requestId,
      requesterId: request.requesterId,
      requestType: "GROUP_CREATE",
      cascadeRejectedChildRequestIds,
    },
    "Family group creation request rejected"
  );

  return jsonResult({ success: true, action });
}
