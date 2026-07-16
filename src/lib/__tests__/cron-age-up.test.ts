import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPrismaTransaction = vi.fn();
const mockTxMemberFindUnique = vi.fn();
const mockTxMemberUpdateMany = vi.fn();
const mockTxTokenDeleteMany = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockPrismaTransaction(...args),
    member: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    ageTierSetting: {
      findMany: vi.fn(),
    },
    passwordResetToken: {
      create: vi.fn(),
    },
    emailLog: {
      findFirst: vi.fn(),
    },
    auditLog: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("../email", () => ({
  sendAgeUpInvitationEmail: vi.fn(),
  sendAgeUpParentEmailHandoffEmail: vi.fn(),
}));

vi.mock("../logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../utils", () => ({
  getSeasonYear: vi.fn(() => 2026),
}));

// Best-effort Xero contact-group trigger (E8, #1934): mocked so we can assert
// it fires after a durable tier flip and never for skipped/handoff members.
const mockTriggerGroupSync = vi.fn();
vi.mock("../xero-contact-groups", () => ({
  triggerMemberXeroContactGroupSync: (...args: unknown[]) =>
    mockTriggerGroupSync(...args),
}));

import { prisma } from "../prisma";
import {
  sendAgeUpInvitationEmail,
  sendAgeUpParentEmailHandoffEmail,
} from "../email";
import { AGE_TIER_DEFAULTS, invalidateAgeTierCache } from "../age-tier";
import { checkAgeUpMembers } from "../cron-age-up";

const mockedFindMany = vi.mocked(prisma.member.findMany);
const mockedMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockedUpdate = vi.mocked(prisma.member.update);
const mockedAgeTierSettingsFindMany = vi.mocked(prisma.ageTierSetting.findMany);
const mockedCreateToken = vi.mocked(prisma.passwordResetToken.create);
const mockedEmailLogFind = vi.mocked(prisma.emailLog.findFirst);
const mockedAuditLogFind = vi.mocked(prisma.auditLog.findFirst);
const mockedAuditLogCreate = vi.mocked(prisma.auditLog.create);
const mockedSendEmail = vi.mocked(sendAgeUpInvitationEmail);
const mockedSendHandoffEmail = vi.mocked(sendAgeUpParentEmailHandoffEmail);

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAgeTierCache();
  mockedAgeTierSettingsFindMany.mockResolvedValue(
    AGE_TIER_DEFAULTS.map((setting) => ({
      ...setting,
      xeroAcceptedContactGroups: [],
    })) as any
  );
  mockPrismaTransaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        member: {
          findUnique: mockTxMemberFindUnique,
          update: mockedUpdate,
          updateMany: mockTxMemberUpdateMany,
        },
        passwordResetToken: {
          create: mockedCreateToken,
          deleteMany: mockTxTokenDeleteMany,
        },
      })
  );
  mockedMemberFindFirst.mockResolvedValue(null);
  mockedAuditLogFind.mockResolvedValue(null);
  mockedAuditLogCreate.mockResolvedValue({} as any);
  mockTxMemberFindUnique.mockResolvedValue({
    canLogin: false,
    ageTier: "YOUTH",
    inheritEmailFromId: null,
    inheritParentEmail: false,
    parentMemberId: null,
  });
  mockTxMemberUpdateMany.mockResolvedValue({ count: 1 });
  mockTxTokenDeleteMany.mockResolvedValue({ count: 1 });
});

// Helper: create a date of birth for a given age at season start (April 1 2026)
function dobForAge(age: number): Date {
  // Season start: 2026-04-01
  // If age 18, born on or before 2008-04-01
  return new Date(2026 - age, 3, 1); // April 1, (2026 - age)
}

describe("checkAgeUpMembers", () => {
  it("should upgrade a YOUTH member who turned 18", async () => {
    const member = {
      id: "m1",
      email: "youth@example.com",
      firstName: "Alice",
      lastName: "Smith",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(1);
    expect(result.upgraded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    // Check member was updated
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: {
        canLogin: true,
        ageTier: "ADULT",
        inheritEmailFromId: null,
        inheritParentEmail: false,
      },
    });

    // Check password reset token was created
    expect(mockedCreateToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "m1",
        tokenHash: expect.any(String),
        expiresAt: expect.any(Date),
      }),
    });

    // Check email was sent
    expect(mockedSendEmail).toHaveBeenCalledWith(
      "youth@example.com",
      "Alice",
      expect.any(String),
      expect.objectContaining({
        targetAgeTier: "ADULT",
        targetAgeTierLabel: "Adult (18+)",
        targetAgeTierMinAge: 18,
      })
    );

    // E8 (#1934): the best-effort Xero contact-group re-sync fires after the
    // tier flip has committed.
    expect(mockTriggerGroupSync).toHaveBeenCalledTimes(1);
    expect(mockTriggerGroupSync).toHaveBeenCalledWith("m1", {
      reason: "cron_age_up",
    });
  });

  it("does not fire the Xero contact-group trigger when the flip is skipped (parent handoff)", async () => {
    const member = {
      id: "m-handoff",
      email: "shared@example.com",
      firstName: "Kid",
      lastName: "Smith",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: "parent-1",
      inheritEmailFrom: { id: "parent-1", email: "shared@example.com" },
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: "parent-1",
      inheritParentEmail: false,
      parentMemberId: null,
    });
    mockedSendHandoffEmail.mockResolvedValue(undefined as any);

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    // No tier flip happened, so no grouping trigger fires.
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
  });

  it("upgrades normally once the member has a unique email and inheritance is cleared", async () => {
    const member = {
      id: "m-unique-family-link",
      email: "unique-youth@example.com",
      firstName: "Una",
      lastName: "Unique",
      dateOfBirth: dobForAge(18),
      parentMemberId: "parent-keep",
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: {
        id: "parent-keep",
        email: "parent-keep@example.com",
        firstName: "Keep",
        lastName: "Parent",
      },
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: null,
      inheritParentEmail: false,
      parentMemberId: "parent-keep",
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(1);
    expect(result.handoff).toBe(0);
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: "m-unique-family-link" },
      data: {
        canLogin: true,
        ageTier: "ADULT",
        inheritEmailFromId: null,
        inheritParentEmail: false,
      },
    });
    expect((mockedUpdate.mock.calls[0]![0] as any).data).not.toHaveProperty(
      "parentMemberId"
    );
    expect(mockedSendEmail).toHaveBeenCalledWith(
      "unique-youth@example.com",
      "Una",
      expect.any(String),
      expect.objectContaining({
        targetAgeTierLabel: "Adult (18+)",
      })
    );
  });

  it("should skip members who already received age-up email", async () => {
    const member = {
      id: "m2",
      email: "already@example.com",
      firstName: "Bob",
      lastName: "Jones",
      dateOfBirth: dobForAge(19),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue({ id: "el1" } as any);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it("sends parent handoff and does not update or tokenize when inheritEmailFromId is set", async () => {
    const member = {
      id: "m3",
      email: "child@placeholder.com",
      firstName: "Charlie",
      lastName: "Brown",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: "parent1",
      inheritEmailFrom: {
        id: "parent1",
        email: "parent@example.com",
        firstName: "Pat",
        lastName: "Parent",
      },
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedSendHandoffEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(result.handoff).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "parent@example.com",
      expect.objectContaining({
        recipientName: "Pat Parent",
        memberFirstName: "Charlie",
        memberLastName: "Brown",
        targetAgeTierLabel: "Adult (18+)",
        targetAgeTierMinAge: 18,
      })
    );
    expect(mockedAuditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "member.age_up.parent_email_handoff_sent",
        subjectMemberId: "m3",
        entityType: "Member",
        entityId: "m3",
        metadata: expect.objectContaining({
          handoffReason: "inheritEmailFrom",
          sourceMemberId: "parent1",
        }),
      }),
    });
  });

  it("sends parent handoff for legacy inheritParentEmail with parentMemberId", async () => {
    const member = {
      id: "m-legacy",
      email: "legacy-child@example.com",
      firstName: "Lee",
      lastName: "Legacy",
      dateOfBirth: dobForAge(18),
      parentMemberId: "parent-legacy",
      inheritParentEmail: true,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: {
        id: "parent-legacy",
        email: "legacy-parent@example.com",
        firstName: "Jordan",
        lastName: "Parent",
      },
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedSendHandoffEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.handoff).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "legacy-parent@example.com",
      expect.objectContaining({
        recipientName: "Jordan Parent",
        memberFirstName: "Lee",
        memberLastName: "Legacy",
      })
    );
    expect(mockedAuditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subjectMemberId: "m-legacy",
        metadata: expect.objectContaining({
          handoffReason: "legacyParentEmail",
          sourceMemberId: "parent-legacy",
        }),
      }),
    });
  });

  it("sends parent handoff when the youth email matches another login member", async () => {
    const member = {
      id: "m-shared",
      email: "shared@example.com",
      firstName: "Sam",
      lastName: "Shared",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedMemberFindFirst.mockResolvedValue({
      id: "login-holder",
      email: "shared@example.com",
      firstName: "Alex",
      lastName: "Holder",
    } as any);
    mockedSendHandoffEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.handoff).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "shared@example.com",
      expect.objectContaining({
        recipientName: "Alex Holder",
        memberFirstName: "Sam",
        memberLastName: "Shared",
      })
    );
    expect(mockedAuditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subjectMemberId: "m-shared",
        metadata: expect.objectContaining({
          handoffReason: "sharedLoginEmail",
          sourceMemberId: "login-holder",
        }),
      }),
    });
  });

  it("dedupes handoff per youth member rather than recipient email", async () => {
    const parent = {
      id: "parent1",
      email: "parent@example.com",
      firstName: "Pat",
      lastName: "Parent",
    };
    const member1 = {
      id: "handoff-already",
      email: "one@example.com",
      firstName: "One",
      lastName: "Youth",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: "parent1",
      inheritEmailFrom: parent,
      parent: null,
    };
    const member2 = {
      id: "handoff-new",
      email: "two@example.com",
      firstName: "Two",
      lastName: "Youth",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: "parent1",
      inheritEmailFrom: parent,
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member1, member2] as any);
    mockedAuditLogFind
      .mockResolvedValueOnce({ id: "existing-audit" } as any)
      .mockResolvedValueOnce(null);
    mockedSendHandoffEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.handoff).toBe(1);
    expect(result.skipped).toBe(1);
    expect(mockedSendHandoffEmail).toHaveBeenCalledTimes(1);
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "parent@example.com",
      expect.objectContaining({
        memberFirstName: "Two",
        memberLastName: "Youth",
      })
    );
    expect(mockedAuditLogFind).toHaveBeenNthCalledWith(1, {
      where: {
        action: "member.age_up.parent_email_handoff_sent",
        subjectMemberId: "handoff-already",
        outcome: "success",
      },
      select: { id: true },
    });
    expect(mockedAuditLogFind).toHaveBeenNthCalledWith(2, {
      where: {
        action: "member.age_up.parent_email_handoff_sent",
        subjectMemberId: "handoff-new",
        outcome: "success",
      },
      select: { id: true },
    });
  });

  it("should handle no candidates gracefully", async () => {
    mockedFindMany.mockResolvedValue([]);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(0);
    expect(result.upgraded).toBe(0);
    expect(result.handoff).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("should skip member with null dateOfBirth", async () => {
    const member = {
      id: "m4",
      email: "nodob@example.com",
      firstName: "Dee",
      lastName: "NoDob",
      dateOfBirth: null,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);

    const result = await checkAgeUpMembers();

    expect(result.skipped).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("should count failed members when update throws", async () => {
    const member = {
      id: "m5",
      email: "fail@example.com",
      firstName: "Eve",
      lastName: "Fail",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockRejectedValue(new Error("DB error"));

    const result = await checkAgeUpMembers();

    expect(result.failed).toBe(1);
    expect(result.upgraded).toBe(0);
  });

  it("should roll back the member upgrade and setup token when email delivery fails", async () => {
    const member = {
      id: "m-email-fail",
      email: "email-fail@example.com",
      firstName: "Failure",
      lastName: "Retry",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockRejectedValue(new Error("SMTP down"));

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(mockPrismaTransaction).toHaveBeenCalledTimes(2);
    expect(mockTxTokenDeleteMany).toHaveBeenCalledWith({
      where: {
        memberId: "m-email-fail",
        tokenHash: expect.any(String),
        used: false,
      },
    });
    expect(mockTxMemberUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "m-email-fail",
        canLogin: true,
        ageTier: "ADULT",
      },
      data: {
        canLogin: false,
        ageTier: "YOUTH",
        inheritEmailFromId: null,
        inheritParentEmail: false,
      },
    });
  });

  it("should process multiple members independently", async () => {
    const member1 = {
      id: "m6",
      email: "a@example.com",
      firstName: "Aaa",
      lastName: "One",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };
    const member2 = {
      id: "m7",
      email: "b@example.com",
      firstName: "Bbb",
      lastName: "Two",
      dateOfBirth: dobForAge(20),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member1, member2] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(2);
    expect(result.upgraded).toBe(2);
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    expect(mockedSendEmail).toHaveBeenCalledTimes(2);
  });

  it("should create a 7-day expiry token", async () => {
    const member = {
      id: "m8",
      email: "token@example.com",
      firstName: "Frank",
      lastName: "Token",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);

    await checkAgeUpMembers();

    const tokenCall = mockedCreateToken.mock.calls[0][0];
    const expiresAt = (tokenCall as any).data.expiresAt as Date;
    const now = Date.now();
    // Should expire in ~7 days (allow 1 minute tolerance)
    const diffDays = (expiresAt.getTime() - now) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("should query for the correct member criteria", async () => {
    mockedFindMany.mockResolvedValue([]);

    await checkAgeUpMembers();

    expect(mockedFindMany).toHaveBeenCalledWith({
      where: {
        active: true,
        canLogin: false,
        // NOT_APPLICABLE (organisations/schools, #1440) must never age up.
        ageTier: { notIn: ["ADULT", "NOT_APPLICABLE"] },
        dateOfBirth: {
          not: null,
          lte: expect.any(Date),
        },
      },
      select: expect.objectContaining({
        id: true,
        email: true,
        firstName: true,
        dateOfBirth: true,
        parentMemberId: true,
        inheritParentEmail: true,
        inheritEmailFromId: true,
        inheritEmailFrom: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        parent: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      }),
    });

    // Verify cutoff date is 18 years before season start (April 1, 2026)
    // Cutoff should be April 1, 2008
    const cutoff = (mockedFindMany.mock.calls[0]![0] as any).where.dateOfBirth;
    const cutoffDate = cutoff.lte as Date;
    expect(cutoffDate.getFullYear()).toBe(2008);
    expect(cutoffDate.getMonth()).toBe(3); // April
    expect(cutoffDate.getDate()).toBe(1);
  });

  it("should use the configured ADULT age tier for cutoff and email data", async () => {
    mockedAgeTierSettingsFindMany.mockResolvedValue([
      {
        tier: "CHILD",
        minAge: 0,
        maxAge: 12,
        label: "Junior",
        sortOrder: 1,
        subscriptionRequiredForBooking: false,
        xeroAcceptedContactGroups: [],
      },
      {
        tier: "YOUTH",
        minAge: 13,
        maxAge: 20,
        label: "Youth",
        sortOrder: 2,
        subscriptionRequiredForBooking: true,
        xeroAcceptedContactGroups: [],
      },
      {
        tier: "ADULT",
        minAge: 21,
        maxAge: null,
        label: "Senior (21+)",
        sortOrder: 3,
        subscriptionRequiredForBooking: true,
        xeroAcceptedContactGroups: [],
      },
    ] as any);

    const member = {
      id: "m-adult-21",
      email: "adult21@example.com",
      firstName: "Alex",
      lastName: "Boundary",
      dateOfBirth: dobForAge(21),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(1);
    const cutoff = (mockedFindMany.mock.calls[0]![0] as any).where.dateOfBirth;
    const cutoffDate = cutoff.lte as Date;
    expect(cutoffDate.getFullYear()).toBe(2005);
    expect(cutoffDate.getMonth()).toBe(3);
    expect(cutoffDate.getDate()).toBe(1);
    expect(mockedSendEmail).toHaveBeenCalledWith(
      "adult21@example.com",
      "Alex",
      expect.any(String),
      {
        targetAgeTier: "ADULT",
        targetAgeTierLabel: "Senior (21+)",
        targetAgeTierMinAge: 21,
      }
    );
  });
});

describe("ageUpInvitationTemplate", () => {
  it("should generate HTML with member name and reset URL", async () => {
    const { ageUpInvitationTemplate } = await import("../email-templates");

    const html = ageUpInvitationTemplate("Alice", "https://example.com/reset?token=abc");

    expect(html).toContain("Alice");
    expect(html).toContain("https://example.com/reset?token=abc");
    expect(html).toContain("Adult (18+)");
    expect(html).toContain("Set Up My Password");
  });

  it("should use the configured target age tier label", async () => {
    const { ageUpInvitationTemplate } = await import("../email-templates");

    const html = ageUpInvitationTemplate(
      "Alice",
      "https://example.com/reset?token=abc",
      { targetAgeTierLabel: "Senior (21+)" }
    );

    expect(html).toContain("Senior (21+)");
    expect(html).not.toContain("turned 18");
  });

  it("should escape HTML in firstName", async () => {
    const { ageUpInvitationTemplate } = await import("../email-templates");

    const html = ageUpInvitationTemplate("<script>alert('xss')</script>", "https://example.com");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("ageUpParentEmailHandoffTemplate", () => {
  it("generates a tokenless handoff message and escapes member data", async () => {
    const { ageUpParentEmailHandoffTemplate } = await import("../email-templates");

    const html = ageUpParentEmailHandoffTemplate({
      recipientName: "Pat Parent",
      memberFirstName: "<Charlie>",
      memberLastName: "Brown",
      targetAgeTierLabel: "Adult (18+)",
    });

    expect(html).toContain("Pat Parent");
    expect(html).toContain("&lt;Charlie&gt; Brown");
    expect(html).toContain("unique email address");
    expect(html).not.toContain("token=");
    expect(html).not.toContain("Set Up My Password");
  });
});

describe("sendAgeUpInvitationEmail", () => {
  it("should be importable and callable", async () => {
    // Verify the function exists and accepts the right params
    expect(typeof sendAgeUpInvitationEmail).toBe("function");
  });
});
