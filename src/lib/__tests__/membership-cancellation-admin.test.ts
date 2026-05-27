import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    member: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    familyGroupMember: {
      deleteMany: vi.fn(),
    },
    membershipCancellationRequestParticipant: {
      update: vi.fn(),
      findMany: vi.fn(),
    },
    membershipCancellationRequest: {
      update: vi.fn(),
    },
  };

  return {
    tx,
    transaction: vi.fn(async (callback: (txArg: typeof tx) => unknown) =>
      callback(tx),
    ),
    participantFindUnique: vi.fn(),
    requestFindUnique: vi.fn(),
    requestFindMany: vi.fn(),
    requestCount: vi.fn(),
    bookingFindMany: vi.fn(),
    bookingGuestFindMany: vi.fn(),
    createAuditLog: vi.fn(),
    sendApprovedEmail: vi.fn(),
    sendRejectedEmail: vi.fn(),
    loadSettings: vi.fn(),
    queueCancellationXeroOperations: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    booking: {
      findMany: mocks.bookingFindMany,
    },
    bookingGuest: {
      findMany: mocks.bookingGuestFindMany,
    },
    membershipCancellationRequest: {
      findUnique: mocks.requestFindUnique,
      findMany: mocks.requestFindMany,
      count: mocks.requestCount,
    },
    membershipCancellationRequestParticipant: {
      findUnique: mocks.participantFindUnique,
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
}));

vi.mock("@/lib/email", () => ({
  sendMembershipCancellationApprovedEmail: mocks.sendApprovedEmail,
  sendMembershipCancellationRejectedEmail: mocks.sendRejectedEmail,
}));

vi.mock("@/lib/membership-cancellation-settings", () => ({
  loadMembershipCancellationSettings: mocks.loadSettings,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  queueApprovedMembershipCancellationXeroOperations:
    mocks.queueCancellationXeroOperations,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  MembershipCancellationAdminError,
  reviewMembershipCancellationParticipant,
} from "@/lib/membership-cancellation-admin";

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@example.org",
    ageTier: "ADULT",
    active: true,
    canLogin: true,
    cancelledAt: null,
    cancelledReason: null,
    cancelledViaRequestId: null,
    ...overrides,
  };
}

function participant(overrides: Record<string, unknown> = {}) {
  return {
    id: "participant-1",
    requestId: "request-1",
    memberId: "member-1",
    status: "REQUESTED",
    reason: null,
    adminNote: null,
    confirmationTokenHash: null,
    confirmationTokenExpiresAt: null,
    confirmedAt: new Date("2026-05-24T00:00:00.000Z"),
    declinedAt: null,
    cancelledAt: null,
    reviewedByMemberId: null,
    reviewedAt: null,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    member: member(),
    request: {
      id: "request-1",
      status: "REQUESTED",
      reason: "Moving away",
      requestedByMemberId: "requester-1",
    },
    ...overrides,
  };
}

function adminRequest(participantOverrides: Record<string, unknown> = {}) {
  const baseParticipant = {
    ...participant(participantOverrides),
    reviewedBy: null,
    member: member(participantOverrides.member as Record<string, unknown> | undefined),
  };

  return {
    id: "request-1",
    requestedByMemberId: "requester-1",
    status: "REQUESTED",
    reason: "Moving away",
    adminNote: null,
    submittedAt: new Date("2026-05-24T00:00:00.000Z"),
    reviewedByMemberId: null,
    reviewedAt: null,
    completedAt: null,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    requestedBy: member({
      id: "requester-1",
      firstName: "Rae",
      lastName: "Requester",
      email: "rae@example.org",
    }),
    reviewedBy: null,
    participants: [baseParticipant],
  };
}

describe("membership cancellation admin review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.participantFindUnique.mockResolvedValue(participant());
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.bookingGuestFindMany.mockResolvedValue([]);
    mocks.tx.membershipCancellationRequestParticipant.findMany.mockResolvedValue([
      { status: "CANCELLED" },
    ]);
    mocks.requestFindUnique.mockResolvedValue(
      adminRequest({ status: "CANCELLED", cancelledAt: new Date("2026-05-24T01:00:00.000Z") }),
    );
    mocks.loadSettings.mockResolvedValue({
      rejoinProcessText: "Contact the club secretary before rejoining.",
    });
    mocks.sendApprovedEmail.mockResolvedValue(undefined);
    mocks.sendRejectedEmail.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.queueCancellationXeroOperations.mockResolvedValue({
      seasonYear: 2026,
      results: [],
    });
  });

  it("approves a confirmed participant and locally cancels the membership", async () => {
    const result = await reviewMembershipCancellationParticipant({
      requestId: "request-1",
      participantId: "participant-1",
      action: "approve",
      adminMemberId: "admin-1",
      adminNote: "Approved by committee",
      ipAddress: "203.0.113.1",
    });

    expect(result.request.participants[0].status).toBe("CANCELLED");
    expect(mocks.tx.member.update).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: expect.objectContaining({
        active: false,
        canLogin: false,
        cancelledAt: expect.any(Date),
        cancelledReason: "Moving away",
        cancelledViaRequestId: "request-1",
        familyGroupId: null,
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
      }),
    });
    expect(mocks.tx.familyGroupMember.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "member-1" },
    });
    expect(mocks.tx.membershipCancellationRequestParticipant.update).toHaveBeenCalledWith({
      where: { id: "participant-1" },
      data: expect.objectContaining({
        status: "CANCELLED",
        adminNote: "Approved by committee",
        reviewedByMemberId: "admin-1",
        confirmationTokenHash: null,
      }),
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.participant_cancelled",
        outcome: "success",
        metadata: expect.objectContaining({ xeroCancellationDeferred: true }),
      }),
      mocks.tx,
    );
    expect(mocks.queueCancellationXeroOperations).toHaveBeenCalledWith({
      memberId: "member-1",
      requestId: "request-1",
      participantId: "participant-1",
      createdByMemberId: "admin-1",
    });
    expect(mocks.sendApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "alice@example.org",
        participantName: "Alice Smith",
        rejoinProcessText: "Contact the club secretary before rejoining.",
      }),
    );
  });

  it("blocks approval when future bookings remain", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        id: "booking-1",
        memberId: "member-1",
        checkIn: new Date("2099-01-01T00:00:00.000Z"),
        checkOut: new Date("2099-01-03T00:00:00.000Z"),
        status: "PAID",
      },
    ]);

    await expect(
      reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<MembershipCancellationAdminError>);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.approval_blocked",
        outcome: "blocked",
        metadata: {
          blockers: [
            expect.objectContaining({
              type: "owned_booking",
              bookingId: "booking-1",
            }),
          ],
        },
      }),
    );
  });

  it("blocks approval when future guest appearances remain", async () => {
    mocks.bookingGuestFindMany.mockResolvedValue([
      {
        id: "guest-1",
        memberId: "member-1",
        stayStart: new Date("2099-02-01T00:00:00.000Z"),
        stayEnd: new Date("2099-02-02T00:00:00.000Z"),
        booking: {
          id: "booking-2",
          checkIn: new Date("2099-02-01T00:00:00.000Z"),
          checkOut: new Date("2099-02-02T00:00:00.000Z"),
          status: "CONFIRMED",
        },
      },
    ]);

    await expect(
      reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<MembershipCancellationAdminError>);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.approval_blocked",
        outcome: "blocked",
        metadata: {
          blockers: [
            expect.objectContaining({
              type: "guest_appearance",
              bookingId: "booking-2",
              guestAppearanceId: "guest-1",
            }),
          ],
        },
      }),
    );
  });

  it("prevents an admin from approving a cancellation request they initiated", async () => {
    mocks.participantFindUnique.mockResolvedValue(
      participant({
        request: {
          id: "request-1",
          status: "REQUESTED",
          reason: "Moving away",
          requestedByMemberId: "admin-1",
        },
      }),
    );

    await expect(
      reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
    } satisfies Partial<MembershipCancellationAdminError>);

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a pending confirmation participant without cancelling the member", async () => {
    mocks.participantFindUnique.mockResolvedValue(
      participant({
        status: "PENDING_CONFIRMATION",
        confirmedAt: null,
        confirmationTokenHash: "hashed-token",
      }),
    );
    mocks.tx.membershipCancellationRequestParticipant.findMany.mockResolvedValue([
      { status: "REJECTED" },
    ]);
    mocks.requestFindUnique.mockResolvedValue(adminRequest({ status: "REJECTED" }));

    await reviewMembershipCancellationParticipant({
      requestId: "request-1",
      participantId: "participant-1",
      action: "reject",
      adminMemberId: "admin-1",
      adminNote: "Request withdrawn",
    });

    expect(mocks.tx.member.update).not.toHaveBeenCalled();
    expect(mocks.tx.membershipCancellationRequestParticipant.update).toHaveBeenCalledWith({
      where: { id: "participant-1" },
      data: expect.objectContaining({
        status: "REJECTED",
        adminNote: "Request withdrawn",
        confirmationTokenHash: null,
        confirmationTokenExpiresAt: null,
      }),
    });
    expect(mocks.sendRejectedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "alice@example.org",
        participantName: "Alice Smith",
        adminNote: "Request withdrawn",
      }),
    );
  });
});
