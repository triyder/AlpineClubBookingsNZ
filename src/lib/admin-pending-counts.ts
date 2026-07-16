import { prisma } from "@/lib/prisma";
import { buildBookingRequestListWhere } from "@/lib/booking-request";
import { getPendingMembershipCancellationReviewCount } from "@/lib/membership-cancellation-admin";
import {
  getPendingMemberArchiveReviewCount,
  getPendingMemberDeleteReviewCount,
} from "@/lib/member-lifecycle-actions";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { REVIEWED_REQUEST_TYPES } from "@/lib/admin-family-group-requests-service";
import {
  buildUnpaidFinishedStaysWhere,
  buildUnsettledAdditionalFinishedStaysWhere,
} from "@/lib/unpaid-finished-stays";
import { getTodayDateOnly } from "@/lib/date-only";

export type AdminPendingCounts = {
  familyRequests: number;
  memberApplications: number;
  refundAppeals: number;
  creditApprovals: number;
  bookingReviews: number;
  bookingChangeRequests: number;
  publicBookingRequests: number;
  unpaidFinishedStays: number;
  unsettledAdditionalFinishedStays: number;
  membershipCancellations: number;
  archiveRequests: number;
  deletionRequests: number;
  memberDeleteRequests: number;
  issueReports: number;
  unassignedHutLeaderDates: number;
};

/**
 * All admin queue counts in one query batch, for the sidebar badges.
 *
 * ponytail: each count mirrors the where-clause of its queue route/service
 * (family-groups/requests, member-applications, refund-requests,
 * credit-approvals, booking-reviews, booking-change-requests,
 * booking-requests, unpaid-finished-stays and unsettled finished-stay
 * additions (shared helpers with the dashboard cards, #1709/#1731/#1723),
 * membership-cancellation-requests,
 * member-lifecycle-action-requests (ARCHIVE and DELETE review queues),
 * deletion-requests, issue-reports,
 * hut-leaders/unassigned-dates); update both together if a queue definition
 * changes.
 */
export async function getAdminPendingCounts(): Promise<AdminPendingCounts> {
  const [
    familyRequests,
    memberApplications,
    refundAppeals,
    creditApprovals,
    bookingReviews,
    bookingChangeRequests,
    publicBookingRequests,
    unpaidFinishedStays,
    unsettledAdditionalFinishedStays,
    membershipCancellations,
    archiveRequests,
    deletionRequests,
    memberDeleteRequests,
    issueReports,
    unassignedDates,
  ] = await Promise.all([
    prisma.familyGroupJoinRequest.count({
      where: { status: "PENDING", type: { in: [...REVIEWED_REQUEST_TYPES] } },
    }),
    prisma.memberApplication.count({ where: { status: "PENDING_ADMIN" } }),
    prisma.refundRequest.count({ where: { status: "PENDING" } }),
    prisma.adminCreditAdjustmentRequest.count({ where: { status: "PENDING" } }),
    prisma.booking.count({
      where: { deletedAt: null, adminReviewStatus: "PENDING" },
    }),
    prisma.bookingChangeRequest.count({ where: { status: "REQUESTED" } }),
    prisma.bookingRequest.count({
      where: buildBookingRequestListWhere("QUEUE"),
    }),
    prisma.booking.count({
      where: buildUnpaidFinishedStaysWhere(getTodayDateOnly()),
    }),
    prisma.booking.count({
      where: buildUnsettledAdditionalFinishedStaysWhere(getTodayDateOnly()),
    }),
    getPendingMembershipCancellationReviewCount(),
    getPendingMemberArchiveReviewCount(),
    prisma.deletionRequest.count({ where: { status: "PENDING" } }),
    getPendingMemberDeleteReviewCount(),
    prisma.issueReport.count({ where: { resolvedAt: null } }),
    getUnassignedHutLeaderDates(),
  ]);

  return {
    familyRequests,
    memberApplications,
    refundAppeals,
    creditApprovals,
    bookingReviews,
    bookingChangeRequests,
    publicBookingRequests,
    unpaidFinishedStays,
    unsettledAdditionalFinishedStays,
    membershipCancellations,
    archiveRequests,
    deletionRequests,
    memberDeleteRequests,
    issueReports,
    unassignedHutLeaderDates: unassignedDates.length,
  };
}
