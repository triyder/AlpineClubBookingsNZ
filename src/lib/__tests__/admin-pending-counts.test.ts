import { describe, expect, it, vi, beforeEach } from "vitest";
import { BookingRequestStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  familyGroupJoinRequestCount: vi.fn(),
  memberApplicationCount: vi.fn(),
  refundRequestCount: vi.fn(),
  adminCreditAdjustmentRequestCount: vi.fn(),
  bookingCount: vi.fn(),
  bookingChangeRequestCount: vi.fn(),
  bookingRequestCount: vi.fn(),
  deletionRequestCount: vi.fn(),
  issueReportCount: vi.fn(),
  getPendingMembershipCancellationReviewCount: vi.fn(),
  getPendingMemberArchiveReviewCount: vi.fn(),
  getPendingMemberDeleteReviewCount: vi.fn(),
  getUnassignedHutLeaderDates: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    familyGroupJoinRequest: { count: mocks.familyGroupJoinRequestCount },
    memberApplication: { count: mocks.memberApplicationCount },
    refundRequest: { count: mocks.refundRequestCount },
    adminCreditAdjustmentRequest: {
      count: mocks.adminCreditAdjustmentRequestCount,
    },
    booking: { count: mocks.bookingCount },
    bookingChangeRequest: { count: mocks.bookingChangeRequestCount },
    bookingRequest: { count: mocks.bookingRequestCount },
    deletionRequest: { count: mocks.deletionRequestCount },
    issueReport: { count: mocks.issueReportCount },
  },
}));

vi.mock("@/lib/membership-cancellation-admin", () => ({
  getPendingMembershipCancellationReviewCount:
    mocks.getPendingMembershipCancellationReviewCount,
}));

vi.mock("@/lib/member-lifecycle-actions", () => ({
  getPendingMemberArchiveReviewCount: mocks.getPendingMemberArchiveReviewCount,
  getPendingMemberDeleteReviewCount: mocks.getPendingMemberDeleteReviewCount,
}));

vi.mock("@/lib/hut-leader-coverage", () => ({
  getUnassignedHutLeaderDates: mocks.getUnassignedHutLeaderDates,
}));

import { getAdminPendingCounts } from "@/lib/admin-pending-counts";
import { getTodayDateOnly } from "@/lib/date-only";

describe("getAdminPendingCounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.familyGroupJoinRequestCount.mockResolvedValue(1);
    mocks.memberApplicationCount.mockResolvedValue(2);
    mocks.refundRequestCount.mockResolvedValue(3);
    mocks.adminCreditAdjustmentRequestCount.mockResolvedValue(4);
    // prisma.booking.count backs three queues: pending admin booking reviews,
    // unpaid finished stays (#1731), and unsettled finished-stay additions
    // (#1723); discriminate on the where-clause.
    mocks.bookingCount.mockImplementation(
      async ({ where }: { where: { status?: unknown; payment?: unknown } }) => {
        if (where.payment) return 13;
        return where.status === "PAYMENT_PENDING" ? 12 : 5;
      },
    );
    mocks.bookingChangeRequestCount.mockResolvedValue(6);
    mocks.bookingRequestCount.mockResolvedValue(7);
    mocks.getPendingMembershipCancellationReviewCount.mockResolvedValue(8);
    mocks.getPendingMemberArchiveReviewCount.mockResolvedValue(9);
    mocks.deletionRequestCount.mockResolvedValue(10);
    mocks.getPendingMemberDeleteReviewCount.mockResolvedValue(14);
    mocks.issueReportCount.mockResolvedValue(11);
    mocks.getUnassignedHutLeaderDates.mockResolvedValue([
      "2026-07-04",
      "2026-07-05",
    ]);
  });

  it("returns every queue count keyed for the sidebar", async () => {
    expect(await getAdminPendingCounts()).toEqual({
      familyRequests: 1,
      memberApplications: 2,
      refundAppeals: 3,
      creditApprovals: 4,
      bookingReviews: 5,
      bookingChangeRequests: 6,
      publicBookingRequests: 7,
      unpaidFinishedStays: 12,
      unsettledAdditionalFinishedStays: 13,
      membershipCancellations: 8,
      archiveRequests: 9,
      deletionRequests: 10,
      memberDeleteRequests: 14,
      issueReports: 11,
      unassignedHutLeaderDates: 2,
    });
  });

  // These where-clauses mirror the individual queue routes; if one of these
  // assertions fails, the matching route's queue definition changed and
  // admin-pending-counts.ts must be updated with it.
  it("counts with the same where-clauses as the queue routes", async () => {
    await getAdminPendingCounts();

    expect(mocks.familyGroupJoinRequestCount).toHaveBeenCalledWith({
      where: {
        status: "PENDING",
        type: {
          in: [
            "JOIN_REQUEST",
            "CHILD_REQUEST",
            "ADULT_REQUEST",
            "REMOVAL_REQUEST",
            "GROUP_CREATE",
          ],
        },
      },
    });
    expect(mocks.memberApplicationCount).toHaveBeenCalledWith({
      where: { status: "PENDING_ADMIN" },
    });
    expect(mocks.refundRequestCount).toHaveBeenCalledWith({
      where: { status: "PENDING" },
    });
    expect(mocks.adminCreditAdjustmentRequestCount).toHaveBeenCalledWith({
      where: { status: "PENDING" },
    });
    expect(mocks.bookingCount).toHaveBeenCalledWith({
      where: { deletedAt: null, adminReviewStatus: "PENDING" },
    });
    // Unpaid finished stays (#1709/#1731): mirrors the dashboard attention
    // card via the shared src/lib/unpaid-finished-stays.ts predicate.
    expect(mocks.bookingCount).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: "PAYMENT_PENDING",
        checkOut: { lte: getTodayDateOnly() },
      },
    });
    // Unsettled finished-stay additions (#1723 path 2): mirrors the sibling
    // dashboard card via the same shared module. Statuses deliberately
    // exclude PAYMENT_PENDING so the two booking queues stay disjoint.
    expect(mocks.bookingCount).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        checkOut: { lte: getTodayDateOnly() },
        status: { in: ["CONFIRMED", "PAID", "COMPLETED"] },
        payment: {
          is: {
            additionalAmountCents: { gt: 0 },
            OR: [
              { additionalPaymentStatus: null },
              { additionalPaymentStatus: { not: "SUCCEEDED" } },
            ],
          },
        },
      },
    });
    expect(mocks.bookingChangeRequestCount).toHaveBeenCalledWith({
      where: { status: "REQUESTED" },
    });
    expect(mocks.bookingRequestCount).toHaveBeenCalledWith({
      where: {
        status: {
          in: [
            BookingRequestStatus.VERIFIED,
            BookingRequestStatus.PRICED,
            BookingRequestStatus.QUOTED,
            BookingRequestStatus.QUOTE_SENT,
            BookingRequestStatus.QUERY_PENDING,
            BookingRequestStatus.MODIFICATION_REQUESTED,
          ],
        },
      },
    });
    expect(mocks.deletionRequestCount).toHaveBeenCalledWith({
      where: { status: "PENDING" },
    });
    expect(mocks.issueReportCount).toHaveBeenCalledWith({
      where: { resolvedAt: null },
    });
  });
});
