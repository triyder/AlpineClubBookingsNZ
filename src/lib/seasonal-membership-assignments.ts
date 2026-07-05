import { createHmac, timingSafeEqual } from "crypto";
import type {
  BookingStatus,
  MembershipTypeBookingBehavior,
  MembershipTypeSubscriptionBehavior,
  Prisma,
  SubscriptionStatus,
} from "@prisma/client";
import { capacityHoldingBookingFilter } from "@/lib/booking-status";
import {
  formatDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import {
  buildStructuredAuditLogCreateArgs,
  type StructuredAuditEvent,
} from "@/lib/audit";
import { prisma } from "@/lib/prisma";

// test seam
export const SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION =
  "admin.member.seasonal_membership_type_changed";
// test seam
export const SEASONAL_MEMBERSHIP_ASSIGNMENTS_ROLLED_FORWARD_ACTION =
  "admin.membership_type_assignments.rolled_forward";

const BOOKING_SUMMARY_LIMIT = 10;
const SUBSCRIPTION_HISTORY_LIMIT = 5;
const PREVIEW_TOKEN_VERSION = 1;

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
} satisfies Prisma.MembershipTypeSelect;

const assignmentInclude = {
  membershipType: { select: membershipTypeSelect },
} satisfies Prisma.SeasonalMembershipAssignmentInclude;

const assignmentWithMemberInclude = {
  member: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      active: true,
      archivedAt: true,
      cancelledAt: true,
    },
  },
  membershipType: { select: membershipTypeSelect },
} satisfies Prisma.SeasonalMembershipAssignmentInclude;

type SeasonalMembershipReadClient =
  | typeof prisma
  | Prisma.TransactionClient;

type MembershipTypeSummary = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: MembershipTypeBookingBehavior;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior;
  sortOrder: number;
};

type SeasonalAssignmentWithType = {
  id: string;
  memberId: string;
  seasonYear: number;
  membershipTypeId: string;
  applyFrom: Date | null;
  assignedByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
  membershipType: MembershipTypeSummary;
};

type BookingPreviewRecord = {
  id: string;
  checkIn: Date;
  checkOut: Date;
  status: BookingStatus;
  finalPriceCents: number;
  waitlistPosition?: number | null;
  waitlistOfferedAt?: Date | null;
  waitlistOfferExpiresAt?: Date | null;
  _count: { guests: number };
};

type SubscriptionPreviewRecord = {
  id: string;
  seasonYear: number;
  status: SubscriptionStatus;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  paidAt: Date | null;
};

export type SerializedMembershipTypeSummary = ReturnType<
  typeof serializeMembershipTypeSummary
>;

export type SerializedSeasonalMembershipAssignment = ReturnType<
  typeof serializeSeasonalMembershipAssignment
>;

export type SeasonalMembershipBookingSummary = ReturnType<
  typeof summarizeBookings
>;

export type SeasonalMembershipChangePreview = {
  memberId: string;
  seasonYear: number;
  generatedAt: string;
  applyFrom: string | null;
  previousAssignment: SerializedSeasonalMembershipAssignment | null;
  newMembershipType: SerializedMembershipTypeSummary;
  resultingBookingBehavior: MembershipTypeBookingBehavior;
  resultingSubscriptionBehavior: MembershipTypeSubscriptionBehavior;
  behaviorChanged: boolean;
  bookingBehaviorChanged: boolean;
  subscriptionBehaviorChanged: boolean;
  affectedCounts: {
    futureConfirmedBookings: number;
    draftBookings: number;
    waitlistRecords: number;
  };
  futureConfirmedBookings: SeasonalMembershipBookingSummary;
  draftBookings: SeasonalMembershipBookingSummary;
  waitlistRecords: SeasonalMembershipBookingSummary;
  currentSeasonSubscription: {
    seasonYear: number;
    status: SubscriptionStatus | "NO_RECORD";
    hasInvoice: boolean;
    xeroInvoiceNumber: string | null;
    paidAt: string | null;
  };
  subscriptionHistory: {
    totalRecords: number;
    statusCounts: Partial<Record<SubscriptionStatus, number>>;
    recent: Array<{
      seasonYear: number;
      status: SubscriptionStatus;
      hasInvoice: boolean;
      xeroInvoiceNumber: string | null;
      paidAt: string | null;
    }>;
  };
  previewToken: string;
};

export type RollForwardExceptionCode =
  | "missing_prior_assignment"
  | "inactive_membership_type";

export type SeasonalMembershipRollForwardException = {
  code: RollForwardExceptionCode;
  memberId: string;
  memberName: string;
  memberEmail: string;
  membershipTypeId?: string;
  membershipTypeName?: string;
};

type JsonRouteResult = {
  body: unknown;
  init?: ResponseInit;
};

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init };
}

function serializeMembershipTypeSummary(type: MembershipTypeSummary) {
  return {
    id: type.id,
    key: type.key,
    name: type.name,
    description: type.description,
    isActive: type.isActive,
    isBuiltIn: type.isBuiltIn,
    bookingBehavior: type.bookingBehavior,
    subscriptionBehavior: type.subscriptionBehavior,
    sortOrder: type.sortOrder,
  };
}

export function serializeSeasonalMembershipAssignment(
  assignment: SeasonalAssignmentWithType,
) {
  return {
    id: assignment.id,
    memberId: assignment.memberId,
    seasonYear: assignment.seasonYear,
    membershipTypeId: assignment.membershipTypeId,
    applyFrom: assignment.applyFrom
      ? formatDateOnly(assignment.applyFrom)
      : null,
    assignedByMemberId: assignment.assignedByMemberId,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
    membershipType: serializeMembershipTypeSummary(assignment.membershipType),
  };
}

function serializeBookingSummary(booking: BookingPreviewRecord) {
  return {
    id: booking.id,
    checkIn: formatDateOnly(booking.checkIn),
    checkOut: formatDateOnly(booking.checkOut),
    status: booking.status,
    finalPriceCents: booking.finalPriceCents,
    guestCount: booking._count.guests,
    waitlistPosition: booking.waitlistPosition ?? null,
    waitlistOfferedAt: booking.waitlistOfferedAt?.toISOString() ?? null,
    waitlistOfferExpiresAt:
      booking.waitlistOfferExpiresAt?.toISOString() ?? null,
  };
}

function summarizeBookings(bookings: BookingPreviewRecord[]) {
  return {
    count: bookings.length,
    truncatedCount: Math.max(0, bookings.length - BOOKING_SUMMARY_LIMIT),
    list: bookings.slice(0, BOOKING_SUMMARY_LIMIT).map(serializeBookingSummary),
  };
}

function summarizeSubscriptionHistory(records: SubscriptionPreviewRecord[]) {
  const statusCounts: Partial<Record<SubscriptionStatus, number>> = {};
  for (const record of records) {
    statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;
  }

  return {
    totalRecords: records.length,
    statusCounts,
    recent: records.slice(0, SUBSCRIPTION_HISTORY_LIMIT).map((record) => ({
      seasonYear: record.seasonYear,
      status: record.status,
      hasInvoice: Boolean(record.xeroInvoiceId || record.xeroInvoiceNumber),
      xeroInvoiceNumber: record.xeroInvoiceNumber,
      paidAt: record.paidAt?.toISOString() ?? null,
    })),
  };
}

function getPreviewSecret() {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET or NEXTAUTH_SECRET is required for seasonal membership preview tokens",
    );
  }
  return "seasonal-membership-preview-local-secret";
}

function normalizeApplyFromInput(value: string | null | undefined):
  | { ok: true; date: Date | null; serialized: string | null }
  | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, date: null, serialized: null };
  }

  if (!isDateOnlyString(value)) {
    return { ok: false, error: "Invalid apply-from date" };
  }

  return { ok: true, date: parseDateOnly(value), serialized: value };
}

function previewTokenPayload(preview: Omit<SeasonalMembershipChangePreview, "previewToken">) {
  return {
    version: PREVIEW_TOKEN_VERSION,
    memberId: preview.memberId,
    seasonYear: preview.seasonYear,
    applyFrom: preview.applyFrom,
    previousMembershipTypeId:
      preview.previousAssignment?.membershipTypeId ?? null,
    newMembershipTypeId: preview.newMembershipType.id,
    resultingBookingBehavior: preview.resultingBookingBehavior,
    resultingSubscriptionBehavior: preview.resultingSubscriptionBehavior,
    affectedCounts: preview.affectedCounts,
    behaviorChanged: preview.behaviorChanged,
    bookingBehaviorChanged: preview.bookingBehaviorChanged,
    subscriptionBehaviorChanged: preview.subscriptionBehaviorChanged,
  };
}

export function buildSeasonalMembershipPreviewToken(
  preview: Omit<SeasonalMembershipChangePreview, "previewToken">,
): string {
  return createHmac("sha256", getPreviewSecret())
    .update(JSON.stringify(previewTokenPayload(preview)))
    .digest("hex");
}

export function verifySeasonalMembershipPreviewToken(
  preview: Omit<SeasonalMembershipChangePreview, "previewToken">,
  token: string,
): boolean {
  const expected = buildSeasonalMembershipPreviewToken(preview);
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);

  return (
    expectedBuffer.length === tokenBuffer.length &&
    timingSafeEqual(expectedBuffer, tokenBuffer)
  );
}

export async function getSeasonalMembershipChangePreview(params: {
  memberId: string;
  seasonYear: number;
  membershipTypeId: string;
  applyFrom?: string | null;
  now?: Date;
  db?: SeasonalMembershipReadClient;
}): Promise<JsonRouteResult> {
  const db = params.db ?? prisma;
  const today = params.now ?? getTodayDateOnly();
  const normalizedApplyFrom = normalizeApplyFromInput(params.applyFrom);
  if (!normalizedApplyFrom.ok) {
    return jsonResult({ error: normalizedApplyFrom.error }, { status: 400 });
  }

  const [member, newMembershipType, previousAssignment] = await Promise.all([
    db.member.findUnique({
      where: { id: params.memberId },
      select: { id: true },
    }),
    db.membershipType.findUnique({
      where: { id: params.membershipTypeId },
      select: membershipTypeSelect,
    }),
    db.seasonalMembershipAssignment.findUnique({
      where: {
        memberId_seasonYear: {
          memberId: params.memberId,
          seasonYear: params.seasonYear,
        },
      },
      include: assignmentInclude,
    }),
  ]);

  if (!member) {
    return jsonResult({ error: "Member not found" }, { status: 404 });
  }

  if (!newMembershipType) {
    return jsonResult({ error: "Membership type not found" }, { status: 404 });
  }

  if (!newMembershipType.isActive) {
    return jsonResult(
      { error: "Archived membership types cannot be newly assigned" },
      { status: 409 },
    );
  }

  const bookingSelect = {
    id: true,
    checkIn: true,
    checkOut: true,
    status: true,
    finalPriceCents: true,
    waitlistPosition: true,
    waitlistOfferedAt: true,
    waitlistOfferExpiresAt: true,
    _count: { select: { guests: true } },
  } satisfies Prisma.BookingSelect;

  const [
    futureConfirmedBookings,
    draftBookings,
    waitlistRecords,
    subscriptions,
  ] = await Promise.all([
    db.booking.findMany({
      where: {
        memberId: params.memberId,
        deletedAt: null,
        checkOut: { gt: today },
        // Capacity-holding population (issue #1254): holding statuses plus
        // request-converted PENDING holds.
        ...capacityHoldingBookingFilter(),
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
      select: bookingSelect,
    }),
    db.booking.findMany({
      where: {
        memberId: params.memberId,
        deletedAt: null,
        checkOut: { gt: today },
        status: "DRAFT",
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
      select: bookingSelect,
    }),
    db.booking.findMany({
      where: {
        memberId: params.memberId,
        deletedAt: null,
        checkOut: { gt: today },
        status: { in: ["WAITLISTED", "WAITLIST_OFFERED"] },
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
      select: bookingSelect,
    }),
    db.memberSubscription.findMany({
      where: { memberId: params.memberId },
      orderBy: [{ seasonYear: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        seasonYear: true,
        status: true,
        xeroInvoiceId: true,
        xeroInvoiceNumber: true,
        paidAt: true,
      },
    }),
  ]);

  const currentSubscription = subscriptions.find(
    (subscription) => subscription.seasonYear === params.seasonYear,
  );
  const previousMembershipType = previousAssignment?.membershipType ?? null;
  const bookingBehaviorChanged = previousMembershipType
    ? previousMembershipType.bookingBehavior !==
      newMembershipType.bookingBehavior
    : true;
  const subscriptionBehaviorChanged = previousMembershipType
    ? previousMembershipType.subscriptionBehavior !==
      newMembershipType.subscriptionBehavior
    : true;

  const previewWithoutToken: Omit<
    SeasonalMembershipChangePreview,
    "previewToken"
  > = {
    memberId: params.memberId,
    seasonYear: params.seasonYear,
    generatedAt: new Date().toISOString(),
    applyFrom: normalizedApplyFrom.serialized,
    previousAssignment: previousAssignment
      ? serializeSeasonalMembershipAssignment(
          previousAssignment as SeasonalAssignmentWithType,
        )
      : null,
    newMembershipType: serializeMembershipTypeSummary(newMembershipType),
    resultingBookingBehavior: newMembershipType.bookingBehavior,
    resultingSubscriptionBehavior: newMembershipType.subscriptionBehavior,
    behaviorChanged: bookingBehaviorChanged || subscriptionBehaviorChanged,
    bookingBehaviorChanged,
    subscriptionBehaviorChanged,
    affectedCounts: {
      futureConfirmedBookings: futureConfirmedBookings.length,
      draftBookings: draftBookings.length,
      waitlistRecords: waitlistRecords.length,
    },
    futureConfirmedBookings: summarizeBookings(
      futureConfirmedBookings as BookingPreviewRecord[],
    ),
    draftBookings: summarizeBookings(draftBookings as BookingPreviewRecord[]),
    waitlistRecords: summarizeBookings(
      waitlistRecords as BookingPreviewRecord[],
    ),
    currentSeasonSubscription: {
      seasonYear: params.seasonYear,
      status: currentSubscription?.status ?? "NO_RECORD",
      hasInvoice: Boolean(
        currentSubscription?.xeroInvoiceId ||
          currentSubscription?.xeroInvoiceNumber,
      ),
      xeroInvoiceNumber: currentSubscription?.xeroInvoiceNumber ?? null,
      paidAt: currentSubscription?.paidAt?.toISOString() ?? null,
    },
    subscriptionHistory: summarizeSubscriptionHistory(
      subscriptions as SubscriptionPreviewRecord[],
    ),
  };

  return jsonResult({
    preview: {
      ...previewWithoutToken,
      previewToken: buildSeasonalMembershipPreviewToken(previewWithoutToken),
    },
  });
}

export async function saveSeasonalMembershipAssignment(params: {
  memberId: string;
  seasonYear: number;
  membershipTypeId: string;
  applyFrom?: string | null;
  adminMemberId: string;
  reason: string;
  previewToken: string;
  request?: StructuredAuditEvent["request"];
  db?: typeof prisma;
}): Promise<JsonRouteResult> {
  const reason = params.reason.trim();
  if (!reason) {
    return jsonResult({ error: "Admin reason is required" }, { status: 400 });
  }

  const db = params.db ?? prisma;
  const previewResult = await getSeasonalMembershipChangePreview({
    memberId: params.memberId,
    seasonYear: params.seasonYear,
    membershipTypeId: params.membershipTypeId,
    applyFrom: params.applyFrom,
    db,
  });
  if (previewResult.init?.status && previewResult.init.status >= 400) {
    return previewResult;
  }

  const preview = (previewResult.body as { preview: SeasonalMembershipChangePreview })
    .preview;

  if (
    !verifySeasonalMembershipPreviewToken(
      preview,
      params.previewToken,
    )
  ) {
    return jsonResult(
      {
        error:
          "Membership type change preview is missing or stale. Preview the change again before saving.",
      },
      { status: 409 },
    );
  }

  if (
    preview.previousAssignment?.membershipTypeId === params.membershipTypeId &&
    (preview.previousAssignment.applyFrom ?? null) === preview.applyFrom
  ) {
    return jsonResult({
      assignment: preview.previousAssignment,
      preview,
      changed: false,
    });
  }

  const nextApplyFromDate = preview.applyFrom
    ? parseDateOnly(preview.applyFrom)
    : null;
  const assignment = await db.$transaction(async (tx) => {
    const saved = await tx.seasonalMembershipAssignment.upsert({
      where: {
        memberId_seasonYear: {
          memberId: params.memberId,
          seasonYear: params.seasonYear,
        },
      },
      update: {
        membershipTypeId: params.membershipTypeId,
        applyFrom: nextApplyFromDate,
        assignedByMemberId: params.adminMemberId,
      },
      create: {
        memberId: params.memberId,
        seasonYear: params.seasonYear,
        membershipTypeId: params.membershipTypeId,
        applyFrom: nextApplyFromDate,
        assignedByMemberId: params.adminMemberId,
      },
      include: assignmentInclude,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION,
        actor: { memberId: params.adminMemberId },
        subject: { memberId: params.memberId },
        entity: { type: "SeasonalMembershipAssignment", id: saved.id },
        category: "admin",
        severity: "critical",
        outcome: "success",
        summary: "Seasonal membership type changed",
        metadata: {
          seasonYear: params.seasonYear,
          adminReason: reason,
          previousMembershipType: preview.previousAssignment?.membershipType,
          newMembershipType: preview.newMembershipType,
          previousApplyFrom: preview.previousAssignment?.applyFrom ?? null,
          newApplyFrom: preview.applyFrom,
          affectedCounts: preview.affectedCounts,
          bookingBehaviorChanged: preview.bookingBehaviorChanged,
          subscriptionBehaviorChanged: preview.subscriptionBehaviorChanged,
          behaviorChanged: preview.behaviorChanged,
          resultingBookingBehavior: preview.resultingBookingBehavior,
          resultingSubscriptionBehavior: preview.resultingSubscriptionBehavior,
        },
        request: params.request,
      }),
    );

    return saved;
  });

  return jsonResult({
    assignment: serializeSeasonalMembershipAssignment(
      assignment as SeasonalAssignmentWithType,
    ),
    preview,
    changed: true,
  });
}

function memberDisplayName(member: {
  firstName: string;
  lastName: string;
  email: string;
}) {
  return `${member.firstName} ${member.lastName}`.trim() || member.email;
}

export async function rollForwardSeasonalMembershipAssignments(params: {
  fromSeasonYear: number;
  toSeasonYear: number;
  adminMemberId: string;
  dryRun?: boolean;
  request?: StructuredAuditEvent["request"];
  db?: typeof prisma;
}): Promise<JsonRouteResult> {
  if (params.fromSeasonYear === params.toSeasonYear) {
    return jsonResult(
      { error: "Source and target seasons must be different" },
      { status: 400 },
    );
  }

  const db = params.db ?? prisma;
  const [sourceAssignments, targetAssignments, members] = await Promise.all([
    db.seasonalMembershipAssignment.findMany({
      where: { seasonYear: params.fromSeasonYear },
      include: assignmentWithMemberInclude,
      orderBy: [
        { member: { lastName: "asc" } },
        { member: { firstName: "asc" } },
      ],
    }),
    db.seasonalMembershipAssignment.findMany({
      where: { seasonYear: params.toSeasonYear },
      select: { memberId: true },
    }),
    db.member.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        active: true,
        archivedAt: true,
        cancelledAt: true,
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
  ]);

  const sourceByMemberId = new Map(
    sourceAssignments.map((assignment) => [assignment.memberId, assignment]),
  );
  const targetMemberIds = new Set(
    targetAssignments.map((assignment) => assignment.memberId),
  );

  const exceptions: SeasonalMembershipRollForwardException[] = [];
  for (const member of members) {
    if (!sourceByMemberId.has(member.id) && !targetMemberIds.has(member.id)) {
      exceptions.push({
        code: "missing_prior_assignment",
        memberId: member.id,
        memberName: memberDisplayName(member),
        memberEmail: member.email,
      });
    }
  }

  const copyCandidates = sourceAssignments.filter(
    (assignment) =>
      !targetMemberIds.has(assignment.memberId) &&
      assignment.member.archivedAt === null,
  );
  for (const assignment of copyCandidates) {
    if (!assignment.membershipType.isActive) {
      exceptions.push({
        code: "inactive_membership_type",
        memberId: assignment.memberId,
        memberName: memberDisplayName(assignment.member),
        memberEmail: assignment.member.email,
        membershipTypeId: assignment.membershipTypeId,
        membershipTypeName: assignment.membershipType.name,
      });
    }
  }

  const data = copyCandidates.map((assignment) => ({
    memberId: assignment.memberId,
    seasonYear: params.toSeasonYear,
    membershipTypeId: assignment.membershipTypeId,
    applyFrom: null,
    assignedByMemberId: params.adminMemberId,
  }));

  let copiedCount = 0;
  if (!params.dryRun) {
    copiedCount = await db.$transaction(async (tx) => {
      const result =
        data.length > 0
          ? await tx.seasonalMembershipAssignment.createMany({
              data,
              skipDuplicates: true,
            })
          : { count: 0 };

      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: SEASONAL_MEMBERSHIP_ASSIGNMENTS_ROLLED_FORWARD_ACTION,
          actor: { memberId: params.adminMemberId },
          entity: {
            type: "SeasonalMembershipAssignment",
            id: `${params.fromSeasonYear}->${params.toSeasonYear}`,
          },
          category: "admin",
          severity: "important",
          outcome: "success",
          summary: "Seasonal membership assignments rolled forward",
          metadata: {
            fromSeasonYear: params.fromSeasonYear,
            toSeasonYear: params.toSeasonYear,
            copiedCount: result.count,
            sourceAssignmentCount: sourceAssignments.length,
            skippedExistingCount: targetAssignments.length,
            exceptionCount: exceptions.length,
            exceptions: exceptions.slice(0, 50),
          },
          request: params.request,
        }),
      );

      return result.count;
    });
  }

  return jsonResult({
    fromSeasonYear: params.fromSeasonYear,
    toSeasonYear: params.toSeasonYear,
    dryRun: Boolean(params.dryRun),
    sourceAssignmentCount: sourceAssignments.length,
    wouldCopyCount: data.length,
    copiedCount,
    skippedExistingCount: targetAssignments.length,
    exceptionCount: exceptions.length,
    exceptions,
  });
}
