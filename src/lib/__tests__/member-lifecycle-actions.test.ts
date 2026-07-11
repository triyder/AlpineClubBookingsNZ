import { beforeEach, describe, expect, it, vi } from "vitest";
const mockPrisma = vi.hoisted(() => {
  const countDelegate = () => ({ count: vi.fn().mockResolvedValue(0) });

  return {
    accessRoleDefinition: {
      // Empty definitions: resolution falls back to legacy bundles.
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    memberLifecycleActionRequest: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
    booking: countDelegate(),
    bookingGuest: countDelegate(),
    payment: countDelegate(),
    paymentRefund: countDelegate(),
    paymentRecoveryOperation: countDelegate(),
    memberCredit: countDelegate(),
    adminCreditAdjustmentRequest: countDelegate(),
    refundRequest: countDelegate(),
    memberSubscription: countDelegate(),
    promoRedemption: countDelegate(),
    promoRedemptionAllocation: countDelegate(),
    promoCodeAssignment: countDelegate(),
    nominationToken: countDelegate(),
    memberApplication: countDelegate(),
    membershipCancellationRequest: countDelegate(),
    membershipCancellationRequestParticipant: countDelegate(),
    familyGroupJoinRequest: countDelegate(),
    familyGroupMember: {
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn(),
    },
    hutLeaderAssignment: countDelegate(),
    issueReport: countDelegate(),
    bookingModification: countDelegate(),
    bookingChangeRequest: countDelegate(),
    deletionRequest: countDelegate(),
    xeroObjectLink: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(0),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  };
});

vi.mock("@prisma/client", async () => {
  const actual = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");

  return {
    ...actual,
    MemberLifecycleAction: { ARCHIVE: "ARCHIVE", DELETE: "DELETE" },
    MemberLifecycleActionRequestStatus: {
      REQUESTED: "REQUESTED",
      APPROVED: "APPROVED",
      REJECTED: "REJECTED",
    },
    Role: {
      MEMBER: "MEMBER",
      ADMIN: "ADMIN",
      LODGE: "LODGE",
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendAdminMemberArchiveRequestedAlert: vi.fn().mockResolvedValue(undefined),
  sendAdminMemberDeleteApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminMemberDeleteRejectedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminMemberDeleteRequestedAlert: vi.fn().mockResolvedValue(undefined),
  sendMemberArchiveApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendMemberArchiveRejectedEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } }),
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  requireAdmin: vi.fn().mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
  }),
}));
vi.mock("@/lib/xero", () => ({
  getXeroContactGroupMemberships: vi.fn(),
  isXeroConnected: vi.fn(),
  syncManagedXeroContactGroupForMember: vi.fn(),
  updateXeroContact: vi.fn(),
}));
vi.mock("@/lib/xero-contact-sync", () => ({
  buildXeroContactUpdatePayload: vi.fn(),
  hasMemberXeroContactChanges: vi.fn(),
  shouldRepairXeroContactNameOrder: vi.fn(),
}));
vi.mock("@/lib/xero-api-errors", () => ({
  getXeroApiErrorInfo: vi.fn().mockReturnValue({ handled: true }),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  getAdminMemberArchiveLifecycleRequests,
  createMemberArchiveRequest,
  createMemberDeleteRequest,
  getMemberDeleteEligibility,
  getPendingMemberArchiveReviewCount,
  MemberLifecycleActionError,
  reviewMemberArchiveRequest,
  reviewMemberDeleteRequest,
} from "@/lib/member-lifecycle-actions";
import { DELETE as directDeleteMember } from "@/app/api/admin/members/[id]/route";
import { createAuditLog } from "@/lib/audit";
import {
  sendAdminMemberDeleteRejectedEmail,
  sendMemberArchiveApprovedEmail,
  sendMemberArchiveRejectedEmail,
} from "@/lib/email";

const mockCreateAuditLog = vi.mocked(createAuditLog);
const mockSendArchiveApproved = vi.mocked(sendMemberArchiveApprovedEmail);
const mockSendArchiveRejected = vi.mocked(sendMemberArchiveRejectedEmail);
const mockSendAdminDeleteRejected = vi.mocked(sendAdminMemberDeleteRejectedEmail);

const now = new Date("2026-05-24T10:00:00.000Z");

const cleanMember = {
  id: "member-1",
  email: "erroneous@example.test",
  passwordHash: "hash",
  forcePasswordChange: false,
  passwordChangedAt: null,
  lastLoginAt: null,
  emailVerified: false,
  firstName: "Error",
  lastName: "Record",
  dateOfBirth: null,
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  streetAddressLine1: null,
  streetAddressLine2: null,
  streetCity: null,
  streetRegion: null,
  streetPostalCode: null,
  streetCountry: null,
  postalAddressLine1: null,
  postalAddressLine2: null,
  postalCity: null,
  postalRegion: null,
  postalPostalCode: null,
  postalCountry: null,
  role: "MEMBER",
  accessRoles: [],
  financeAccessLevel: "NONE",
  ageTier: "ADULT",
  xeroContactId: "xero-contact-1",
  active: true,
  canLogin: false,
  profileCompletedAt: null,
  detailsConfirmedAt: null,
  detailsConfirmedByMemberId: null,
  onboardingConfirmedAt: null,
  joinedDate: null,
  cancelledAt: null,
  cancelledReason: null,
  cancelledViaRequestId: null,
  parentMemberId: null,
  inheritParentEmail: true,
  secondaryParentId: null,
  inheritEmailFromId: null,
  familyGroupId: null,
  createdAt: now,
  updatedAt: now,
};

function requestedBy() {
  return {
    id: "admin-1",
    firstName: "Requesting",
    lastName: "Admin",
    email: "requesting-admin@example.test",
  };
}

function reviewedBy() {
  return {
    id: "admin-2",
    firstName: "Reviewing",
    lastName: "Admin",
    email: "reviewing-admin@example.test",
  };
}

function deleteRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "request-1",
    memberId: "member-1",
    action: "DELETE",
    status: "REQUESTED",
    reason: "Created in error",
    reviewNote: null,
    memberSnapshot: null,
    requestedByMemberId: "admin-1",
    requestedAt: now,
    reviewedByMemberId: null,
    reviewedAt: null,
    processedAt: null,
    createdAt: now,
    updatedAt: now,
    requestedBy: requestedBy(),
    reviewedBy: null,
    ...overrides,
  };
}

function archiveTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    firstName: "Former",
    lastName: "Member",
    email: "former@example.test",
    active: false,
    canLogin: false,
    cancelledAt: new Date("2026-05-01T00:00:00.000Z"),
    cancelledReason: "Moved away",
    archivedAt: null,
    archivedReason: null,
    ...overrides,
  };
}

function archiveRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "archive-request-1",
    memberId: "member-1",
    action: "ARCHIVE",
    status: "REQUESTED",
    reason: "Former member confirmed cancellation",
    reviewNote: null,
    memberSnapshot: null,
    requestedByMemberId: "admin-1",
    requestedAt: now,
    reviewedByMemberId: null,
    reviewedAt: null,
    processedAt: null,
    createdAt: now,
    updatedAt: now,
    requestedBy: requestedBy(),
    reviewedBy: null,
    ...overrides,
  };
}

const countDelegates = [
  mockPrisma.memberLifecycleActionRequest,
  mockPrisma.booking,
  mockPrisma.bookingGuest,
  mockPrisma.payment,
  mockPrisma.paymentRefund,
  mockPrisma.paymentRecoveryOperation,
  mockPrisma.memberCredit,
  mockPrisma.adminCreditAdjustmentRequest,
  mockPrisma.refundRequest,
  mockPrisma.memberSubscription,
  mockPrisma.promoRedemptionAllocation,
  mockPrisma.promoCodeAssignment,
  mockPrisma.nominationToken,
  mockPrisma.memberApplication,
  mockPrisma.membershipCancellationRequest,
  mockPrisma.membershipCancellationRequestParticipant,
  mockPrisma.familyGroupJoinRequest,
  mockPrisma.familyGroupMember,
  mockPrisma.member,
  mockPrisma.hutLeaderAssignment,
  mockPrisma.issueReport,
  mockPrisma.bookingModification,
  mockPrisma.bookingChangeRequest,
  mockPrisma.deletionRequest,
];

describe("member delete lifecycle actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.findUnique.mockResolvedValue(cleanMember);
    mockPrisma.xeroObjectLink.findMany.mockResolvedValue([
      {
        id: "link-1",
        localModel: "Member",
        localId: "member-1",
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    mockPrisma.xeroObjectLink.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.member.update.mockResolvedValue({ ...cleanMember, xeroContactId: null });
    mockPrisma.member.delete.mockResolvedValue(cleanMember);
    mockPrisma.memberLifecycleActionRequest.findMany.mockResolvedValue([]);
    mockPrisma.memberLifecycleActionRequest.findUnique.mockResolvedValue(deleteRequest());
    mockPrisma.memberLifecycleActionRequest.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        deleteRequest({
          id: "request-created",
          ...args.data,
          requestedBy: requestedBy(),
        }),
    );
    mockPrisma.memberLifecycleActionRequest.update.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        deleteRequest({
          ...args.data,
          status: args.data.status,
          requestedBy: requestedBy(),
          reviewedBy: args.data.reviewedByMemberId ? reviewedBy() : null,
        }),
    );
    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => Promise<unknown>) =>
        callback(mockPrisma),
    );
    for (const delegate of countDelegates) {
      delegate.count.mockResolvedValue(0);
    }
  });

  it("reports blockers for meaningful member history", async () => {
    mockPrisma.booking.count.mockResolvedValue(1);
    mockPrisma.memberCredit.count.mockResolvedValue(2);

    const eligibility = await getMemberDeleteEligibility({
      memberId: "member-1",
      currentAdminMemberId: "admin-2",
    });

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "owned_bookings", count: 1 }),
        expect.objectContaining({ code: "credits", count: 2 }),
      ]),
    );
  });

  it("ignores placeholder subscription rows without invoice or payment history", async () => {
    const eligibility = await getMemberDeleteEligibility({
      memberId: "member-1",
      currentAdminMemberId: "admin-2",
    });

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.blockers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "subscriptions" }),
      ]),
    );
    expect(mockPrisma.memberSubscription.count).toHaveBeenCalledWith({
      where: {
        memberId: "member-1",
        OR: [
          { status: { in: ["UNPAID", "PAID", "OVERDUE"] } },
          { xeroInvoiceId: { not: null } },
          { xeroInvoiceNumber: { not: null } },
          { xeroOnlineInvoiceUrl: { not: null } },
          { paidAt: { not: null } },
        ],
      },
    });
  });

  it("reports subscription blockers when invoice or payment history exists", async () => {
    mockPrisma.memberSubscription.count.mockResolvedValue(1);

    const eligibility = await getMemberDeleteEligibility({
      memberId: "member-1",
      currentAdminMemberId: "admin-2",
    });

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "subscriptions",
          label: "Membership subscriptions with invoice or payment history exist.",
          count: 1,
        }),
      ]),
    );
  });

  it("creates a delete request only when the member is eligible", async () => {
    const result = await createMemberDeleteRequest({
      memberId: "member-1",
      requestedByMemberId: "admin-1",
      reason: " Created in error ",
    });

    expect(result.request.id).toBe("request-created");
    expect(mockPrisma.memberLifecycleActionRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "DELETE",
          memberId: "member-1",
          reason: "Created in error",
          requestedByMemberId: "admin-1",
          memberSnapshot: expect.objectContaining({
            member: expect.objectContaining({ id: "member-1" }),
          }),
        }),
      }),
    );
  });

  it("requires a different admin to review a delete request", async () => {
    await expect(
      reviewMemberDeleteRequest({
        requestId: "request-1",
        reviewedByMemberId: "admin-1",
        action: "approve",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 403,
    } satisfies Partial<MemberLifecycleActionError>);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("approves by snapshotting, deactivating Xero links, clearing local Xero linkage, and hard deleting", async () => {
    const result = await reviewMemberDeleteRequest({
      requestId: "request-1",
      reviewedByMemberId: "admin-2",
      action: "approve",
      reviewNote: "Checked",
    });

    expect(result.request.status).toBe("APPROVED");
    expect(mockPrisma.xeroObjectLink.updateMany).toHaveBeenCalledWith({
      where: { localModel: "Member", localId: "member-1", active: true },
      data: { active: false },
    });
    expect(mockPrisma.member.update).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { xeroContactId: null },
    });
    expect(mockPrisma.memberLifecycleActionRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPROVED",
          reviewNote: "Checked",
          reviewedByMemberId: "admin-2",
          memberSnapshot: expect.objectContaining({
            member: expect.objectContaining({ id: "member-1" }),
            xeroObjectLinks: expect.arrayContaining([
              expect.objectContaining({ id: "link-1" }),
            ]),
          }),
        }),
      }),
    );
    expect(mockPrisma.member.delete).toHaveBeenCalledWith({
      where: { id: "member-1" },
    });
  });

  it("still emails the requesting admin on a delete reject when notifyMember is false (#1788 carve-out)", async () => {
    // The delete-flow emails go to the requesting admin, not the target member,
    // so an archive-style suppression must never touch them.
    const result = await reviewMemberDeleteRequest({
      requestId: "request-1",
      reviewedByMemberId: "admin-2",
      action: "reject",
      reviewNote: "Not now",
      notifyMember: false,
    });

    expect(result.request.status).toBe("REJECTED");
    expect(mockSendAdminDeleteRejected).toHaveBeenCalledTimes(1);
  });

  it("blocks the legacy direct member DELETE endpoint", async () => {
    const response = await directDeleteMember();

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({
      error:
        "Direct member deletion is disabled. Create a member delete lifecycle request and have a different admin approve it.",
    });
    expect(mockPrisma.member.update).not.toHaveBeenCalled();
    expect(mockPrisma.member.delete).not.toHaveBeenCalled();
  });
});

describe("member archive lifecycle actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.findUnique.mockResolvedValue(archiveTarget());
    mockPrisma.member.findMany.mockResolvedValue([archiveTarget()]);
    mockPrisma.member.update.mockResolvedValue({
      ...archiveTarget(),
      archivedAt: now,
      archivedReason: "Former member confirmed cancellation",
    });
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.familyGroupMember.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.memberLifecycleActionRequest.findFirst.mockResolvedValue(null);
    mockPrisma.memberLifecycleActionRequest.findUnique.mockResolvedValue(archiveRequest());
    mockPrisma.memberLifecycleActionRequest.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        archiveRequest({
          id: "archive-request-created",
          ...args.data,
          requestedBy: requestedBy(),
        }),
    );
    mockPrisma.memberLifecycleActionRequest.update.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        archiveRequest({
          ...args.data,
          requestedBy: requestedBy(),
          reviewedBy: args.data.reviewedByMemberId ? reviewedBy() : null,
        }),
    );
    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => Promise<unknown>) =>
        callback(mockPrisma),
    );
  });

  it("requires cancellation before an archive request can be created", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(
      archiveTarget({ active: true, canLogin: true, cancelledAt: null }),
    );

    await expect(
      createMemberArchiveRequest({
        memberId: "member-1",
        requestedByMemberId: "admin-1",
        reason: "Former member confirmed cancellation",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 409,
    } satisfies Partial<MemberLifecycleActionError>);

    expect(mockPrisma.memberLifecycleActionRequest.create).not.toHaveBeenCalled();
  });

  it("creates an archive request for a cancelled member", async () => {
    const result = await createMemberArchiveRequest({
      memberId: "member-1",
      requestedByMemberId: "admin-1",
      reason: " Former member confirmed cancellation ",
    });

    expect(result.request.id).toBe("archive-request-created");
    expect(mockPrisma.memberLifecycleActionRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ARCHIVE",
          memberId: "member-1",
          reason: "Former member confirmed cancellation",
          requestedByMemberId: "admin-1",
        }),
      }),
    );
  });

  it("lists pending archive requests for admin review", async () => {
    mockPrisma.memberLifecycleActionRequest.findMany.mockResolvedValueOnce([
      archiveRequest(),
    ]);
    mockPrisma.memberLifecycleActionRequest.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);

    const result = await getAdminMemberArchiveLifecycleRequests({
      status: "REQUESTED",
      page: 1,
      pageSize: 25,
    });

    expect(mockPrisma.memberLifecycleActionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: "ARCHIVE", status: "REQUESTED" },
        take: 25,
      }),
    );
    expect(mockPrisma.member.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["member-1"] } },
      select: expect.objectContaining({ archivedAt: true }),
    });
    expect(result.total).toBe(1);
    expect(result.pendingCount).toBe(3);
    expect(result.requests[0]).toMatchObject({
      id: "archive-request-1",
      member: {
        id: "member-1",
        name: "Former Member",
        email: "former@example.test",
      },
    });
  });

  it("counts pending archive requests for review badges", async () => {
    mockPrisma.memberLifecycleActionRequest.count.mockResolvedValueOnce(2);

    await expect(getPendingMemberArchiveReviewCount()).resolves.toBe(2);
    expect(mockPrisma.memberLifecycleActionRequest.count).toHaveBeenCalledWith({
      where: { action: "ARCHIVE", status: "REQUESTED" },
    });
  });

  it("requires a different admin to review an archive request", async () => {
    await expect(
      reviewMemberArchiveRequest({
        requestId: "archive-request-1",
        reviewedByMemberId: "admin-1",
        action: "approve",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 403,
    } satisfies Partial<MemberLifecycleActionError>);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("approves an archive request and removes operational family and email links", async () => {
    const result = await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "approve",
      reviewNote: "Checked",
    });

    expect(result.request.status).toBe("APPROVED");
    expect(mockPrisma.familyGroupMember.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "member-1" },
    });
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: { parentMemberId: "member-1" },
      data: { parentMemberId: null },
    });
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: { secondaryParentId: "member-1" },
      data: { secondaryParentId: null },
    });
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: { inheritEmailFromId: "member-1" },
      data: { inheritEmailFromId: null },
    });
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: { id: "member-1", archivedAt: null },
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        archivedReason: "Former member confirmed cancellation",
        archivedViaLifecycleActionRequestId: "archive-request-1",
        active: false,
        canLogin: false,
      }),
    });
  });

  it("rejects the approval with 409 when the archive claim race-loses", async () => {
    // Simulate a concurrent approver winning: the archive updateMany
    // matches zero rows because archivedAt is already non-null. The
    // happy-path beforeEach sets member.updateMany to { count: 1 } for
    // the three cleanup updateMany calls; override the fourth (the
    // claim) to { count: 0 }.
    mockPrisma.member.updateMany
      .mockResolvedValueOnce({ count: 1 }) // parentMemberId cleanup
      .mockResolvedValueOnce({ count: 1 }) // secondaryParentId cleanup
      .mockResolvedValueOnce({ count: 1 }) // inheritEmailFromId cleanup
      .mockResolvedValueOnce({ count: 0 }); // archive claim - LOST

    await expect(
      reviewMemberArchiveRequest({
        requestId: "archive-request-1",
        reviewedByMemberId: "admin-2",
        action: "approve",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<MemberLifecycleActionError>);
  });

  it("records cleanup link counts in the archive_approved audit log metadata", async () => {
    mockPrisma.familyGroupMember.deleteMany.mockResolvedValueOnce({ count: 3 });
    mockPrisma.member.updateMany
      .mockResolvedValueOnce({ count: 4 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 });

    await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "approve",
      reviewNote: "Checked",
    });

    const archiveApprovedCall = mockCreateAuditLog.mock.calls.find(
      ([entry]) => entry.action === "member_lifecycle.archive_approved",
    );
    expect(archiveApprovedCall).toBeDefined();
    const [archiveApprovedEntry] = archiveApprovedCall!;
    expect(archiveApprovedEntry.metadata).toEqual(
      expect.objectContaining({
        action: "ARCHIVE",
        cleanedFamilyGroupMembers: 3,
        nulledChildren: 4,
        nulledSecondaryParents: 1,
        nulledInheritance: 2,
      }),
    );
  });

  // #1788: per-review member-email choice on the two target-member sends.
  function archiveRejectedMetadata() {
    return mockCreateAuditLog.mock.calls.find(
      ([entry]) => entry.action === "member_lifecycle.archive_rejected",
    )?.[0].metadata;
  }

  function archiveApprovedMetadata() {
    return mockCreateAuditLog.mock.calls.find(
      ([entry]) => entry.action === "member_lifecycle.archive_approved",
    )?.[0].metadata;
  }

  it("emails the target member and records no notify field on a default reject (#1788)", async () => {
    const result = await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "reject",
      reviewNote: "Keep active",
    });

    expect(result.request.status).toBe("REJECTED");
    expect(mockSendArchiveRejected).toHaveBeenCalledTimes(1);
    expect(archiveRejectedMetadata()).not.toHaveProperty("notifyMember");
  });

  it("suppresses the reject email and audits the choice when notifyMember is false (#1788)", async () => {
    const result = await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "reject",
      notifyMember: false,
    });

    // The rejection state change is still applied.
    expect(result.request.status).toBe("REJECTED");
    expect(mockSendArchiveRejected).not.toHaveBeenCalled();
    expect(archiveRejectedMetadata()).toMatchObject({ notifyMember: false });
  });

  it("emails and records no notify field on a reject with notifyMember true (#1788)", async () => {
    await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "reject",
      notifyMember: true,
    });

    expect(mockSendArchiveRejected).toHaveBeenCalledTimes(1);
    expect(archiveRejectedMetadata()).not.toHaveProperty("notifyMember");
  });

  it("emails the target member and records no notify field on a default approve (#1788)", async () => {
    await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "approve",
    });

    expect(mockSendArchiveApproved).toHaveBeenCalledTimes(1);
    expect(archiveApprovedMetadata()).not.toHaveProperty("notifyMember");
  });

  it("suppresses the approve email, still archives, and audits the choice when notifyMember is false (#1788)", async () => {
    const result = await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "approve",
      notifyMember: false,
    });

    expect(result.request.status).toBe("APPROVED");
    // The archive claim (state change) still runs regardless of the choice.
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: { id: "member-1", archivedAt: null },
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        active: false,
        canLogin: false,
      }),
    });
    expect(mockSendArchiveApproved).not.toHaveBeenCalled();
    expect(archiveApprovedMetadata()).toMatchObject({ notifyMember: false });
  });

  it("records no notify field and sends nothing for a member with no email even when notifyMember is false (#1788 honesty rule)", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(archiveTarget({ email: "" }));

    const result = await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "reject",
      notifyMember: false,
    });

    expect(result.request.status).toBe("REJECTED");
    expect(mockSendArchiveRejected).not.toHaveBeenCalled();
    expect(archiveRejectedMetadata()).not.toHaveProperty("notifyMember");
  });
});

// Issue #1604: only a Full Admin may archive an account holding a privileged
// role (the privileged-target guard), enforced canLogin-blind at both request
// creation and approval. The last-admin backstop is vacuous on this path
// because archive requires a prior cancellation (which already cleared
// canLogin), so a cancelled admin is never a counted active Full Admin.
describe("member archive admin-account guards (#1604)", () => {
  const cancelledAdmin = () =>
    archiveTarget({
      role: "ADMIN",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN" }],
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.memberLifecycleActionRequest.findFirst.mockResolvedValue(null);
    mockPrisma.memberLifecycleActionRequest.findUnique.mockResolvedValue(
      archiveRequest(),
    );
    mockPrisma.memberLifecycleActionRequest.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        archiveRequest({
          id: "archive-request-created",
          ...args.data,
          requestedBy: requestedBy(),
        }),
    );
    mockPrisma.memberLifecycleActionRequest.update.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        archiveRequest({
          ...args.data,
          requestedBy: requestedBy(),
          reviewedBy: reviewedBy(),
        }),
    );
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.familyGroupMember.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => Promise<unknown>) =>
        callback(mockPrisma),
    );
  });

  it("privileged-target: a scoped admin cannot request archive of an admin-holding account (403)", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(cancelledAdmin());
    mockPrisma.member.count.mockResolvedValue(0); // requester is not a Full Admin

    await expect(
      createMemberArchiveRequest({
        memberId: "member-1",
        requestedByMemberId: "membership-officer",
        reason: "Cleaning up records",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 403,
    } satisfies Partial<MemberLifecycleActionError>);

    expect(
      mockPrisma.memberLifecycleActionRequest.create,
    ).not.toHaveBeenCalled();
  });

  it("privileged-target: a Full Admin can request archive of an admin-holding account", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(cancelledAdmin());
    mockPrisma.member.count.mockResolvedValue(1); // requester is a Full Admin

    const result = await createMemberArchiveRequest({
      memberId: "member-1",
      requestedByMemberId: "full-admin",
      reason: "Cleaning up records",
    });

    expect(result.request.id).toBe("archive-request-created");
  });

  it("privileged-target: a scoped admin cannot approve archive of an admin-holding account (403)", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(cancelledAdmin());
    mockPrisma.member.count.mockResolvedValue(0); // reviewer is not a Full Admin

    await expect(
      reviewMemberArchiveRequest({
        requestId: "archive-request-1",
        reviewedByMemberId: "membership-officer",
        action: "approve",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 403,
    } satisfies Partial<MemberLifecycleActionError>);

    expect(mockPrisma.member.updateMany).not.toHaveBeenCalled();
  });

  it("privileged-target: a Full Admin can approve archive of an admin-holding account", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(cancelledAdmin());
    // actorIsFullAdmin -> 1; the last-admin target count -> 0 (a cancelled
    // admin is not an active Full Admin), so the backstop short-circuits.
    mockPrisma.member.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    const result = await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "full-admin",
      action: "approve",
    });

    expect(result.request.status).toBe("APPROVED");
  });
});
