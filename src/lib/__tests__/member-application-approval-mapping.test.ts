import { beforeEach, describe, expect, it, vi } from "vitest";

// E10 (#1936): approveMemberApplication mapping paths — promotion vs keep-auth,
// joining-fee SKIP default, token drift + concurrent-approval serialization,
// skip-with-note billing exclusion, collision BLOCK enforcement, and family MAP.

const { prismaMock, emailMock, xeroMock, xeroOutboxMock, billingMock, auditMock } =
  vi.hoisted(() => ({
    prismaMock: {
      member: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      memberApplication: { findUnique: vi.fn(), update: vi.fn() },
      $transaction: vi.fn(),
    },
    emailMock: {
      sendMembershipApplicationApprovedEmail: vi.fn().mockResolvedValue(undefined),
      sendMembershipApplicationRejectedEmail: vi.fn().mockResolvedValue(undefined),
      sendInductionSignOffRequestEmail: vi.fn().mockResolvedValue(undefined),
      sendNominationRequestEmail: vi.fn().mockResolvedValue(undefined),
      sendAdminMembershipApplicationPendingEmail: vi.fn().mockResolvedValue(undefined),
    },
    xeroMock: {
      isXeroConnected: vi.fn().mockResolvedValue(false),
      findOrCreateXeroContact: vi.fn().mockResolvedValue("xc-1"),
    },
    xeroOutboxMock: {
      enqueueXeroEntranceFeeInvoiceOperation: vi.fn().mockResolvedValue({ queueOperationId: "q1", message: "queued" }),
      processQueuedXeroOutboxOperations: vi.fn().mockResolvedValue({ processed: 1 }),
    },
    billingMock: {
      queueApprovedMembershipSubscriptionCharges: vi.fn().mockResolvedValue({ chargeIds: [], exceptionCount: 0 }),
    },
    auditMock: { logAudit: vi.fn() },
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01T00:00:00.000Z")),
}));
vi.mock("@/lib/utils", () => ({ getSeasonYear: vi.fn().mockReturnValue(2026) }));
vi.mock("@/lib/email", () => emailMock);
vi.mock("@/lib/xero", () => xeroMock);
vi.mock("@/lib/xero-operation-outbox", () => xeroOutboxMock);
vi.mock("@/lib/membership-subscription-billing", () => billingMock);
vi.mock("@/lib/audit", () => auditMock);
vi.mock("@/lib/induction", () => ({ createMemberInduction: vi.fn() }));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn().mockResolvedValue({ induction: false }),
}));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("fresh-hash") }));

import { approveMemberApplication } from "@/lib/nomination";
import { buildApprovalMappingPreview } from "@/lib/member-application-mapping";

const APPLICANT_MAP = {
  applicant: { mode: "MAP" as const, memberId: "member-x" },
  family: [] as Array<{ mode: "CREATE" } | { mode: "MAP"; memberId: string }>,
};

function applicationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    updatedAt: new Date("2026-04-12T00:00:00.000Z"),
    applicantFirstName: "Jane",
    applicantLastName: "Doe",
    applicantEmail: "jane@test.com",
    applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
    applicantPhone: "64 21 5551234",
    applicantAddress: null,
    familyMembers: [],
    nominator1Email: "n1@test.com",
    nominator2Email: "n2@test.com",
    nominator1Id: "nom-1",
    nominator2Id: "nom-2",
    nominator1ConfirmedAt: new Date("2026-04-11T00:00:00.000Z"),
    nominator2ConfirmedAt: new Date("2026-04-11T00:00:00.000Z"),
    status: "PENDING_ADMIN",
    adminNotes: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date("2026-04-10T00:00:00.000Z"),
    ...overrides,
  };
}

function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-x",
    email: "old@test.com",
    firstName: "Old",
    lastName: "Name",
    dateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
    ageTier: "ADULT",
    role: "USER",
    active: true,
    archivedAt: null,
    canLogin: false,
    parentMemberId: null,
    inheritParentEmail: false,
    inheritEmailFromId: null,
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
    profileCompletedAt: null,
    detailsConfirmedAt: null,
    detailsConfirmedByMemberId: null,
    onboardingConfirmedAt: null,
    xeroContactId: null,
    updatedAt: new Date("2026-04-10T00:00:00.000Z"),
    familyGroupMemberships: [],
    subscriptions: [],
    seasonalMembershipAssignments: [],
    ...overrides,
  };
}

// A member.findMany that returns targets for id-in queries and [] for the
// suggestions query (archivedAt filter).
function findManyFor(targets: Array<Record<string, unknown>>) {
  return vi.fn(async (args: { where?: { id?: { in?: string[] } } }) => {
    if (args?.where?.id?.in) {
      return targets.filter((row) => args.where!.id!.in!.includes(row.id as string));
    }
    return [];
  });
}

function makeTx(overrides: {
  targets: Array<Record<string, unknown>>;
  loginHolder?: { id: string } | null;
  updateResult?: Record<string, unknown>;
}) {
  const update = vi.fn().mockResolvedValue(
    overrides.updateResult ?? {
      id: "member-x",
      email: "jane@test.com",
      firstName: "Jane",
      lastName: "Doe",
    },
  );
  return {
    tx: {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      member: {
        findMany: findManyFor(overrides.targets),
        findFirst: vi.fn().mockResolvedValue(overrides.loginHolder ?? null),
        create: vi.fn().mockResolvedValue({ id: "member-1", email: "jane@test.com", firstName: "Jane", lastName: "Doe" }),
        update,
      },
      familyGroup: { create: vi.fn().mockResolvedValue({ id: "fg-1" }) },
      familyGroupMember: { create: vi.fn(), upsert: vi.fn() },
      passwordResetToken: { deleteMany: vi.fn(), create: vi.fn() },
      memberApplication: {
        findUnique: vi.fn().mockResolvedValue(applicationRow()),
        update: vi.fn().mockResolvedValue(applicationRow({ status: "APPROVED" })),
      },
    },
    update,
  };
}

async function tokenFor(personDecisions: unknown, targets: Array<Record<string, unknown>>, loginHolder: { id: string } | null = null) {
  prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
  prismaMock.member.findMany.mockImplementation(findManyFor(targets));
  prismaMock.member.findFirst.mockResolvedValue(loginHolder as never);
  const result = await buildApprovalMappingPreview({
    applicationId: "app-1",
    personDecisions: personDecisions as never,
    seasonYear: 2026,
  });
  return (result.body as { preview: { previewToken: string } }).preview.previewToken;
}

beforeEach(() => {
  vi.clearAllMocks();
  xeroMock.isXeroConnected.mockResolvedValue(false);
  billingMock.queueApprovedMembershipSubscriptionCharges.mockResolvedValue({ chargeIds: [], exceptionCount: 0 });
  // Post-approval warning persistence path chains `.update(...).catch(...)`.
  prismaMock.memberApplication.update.mockResolvedValue({} as never);
});

describe("applicant MAP — promotion path (canLogin:false -> true)", () => {
  it("promotes auth, clears inheritance, defaults the joining fee to SKIP, and audits the mapping", async () => {
    const targets = [targetRow({ canLogin: false })];
    const token = await tokenFor(APPLICANT_MAP, targets, null);

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({ targets, loginHolder: null });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await approveMemberApplication(
      "app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token,
    );

    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      canLogin: true,
      passwordHash: "fresh-hash",
      emailVerified: true,
      inheritEmailFromId: null,
      inheritParentEmail: false,
      email: "jane@test.com",
      profileCompletedAt: expect.any(Date),
      detailsConfirmedAt: expect.any(Date),
      onboardingConfirmedAt: expect.any(Date),
    });
    expect(tx.passwordResetToken.create).toHaveBeenCalledTimes(1);
    expect(xeroOutboxMock.enqueueXeroEntranceFeeInvoiceOperation).not.toHaveBeenCalled();
    expect(emailMock.sendMembershipApplicationApprovedEmail).toHaveBeenCalledTimes(1);
    expect(result.mappedMemberIds).toEqual(["member-x"]);
    expect(result.createdMemberIds).toEqual([]);
    expect(auditMock.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBER_APPLICATION_MAPPED_TO_EXISTING", severity: "critical" }),
    );
    expect(billingMock.queueApprovedMembershipSubscriptionCharges).toHaveBeenCalledWith({
      memberIds: ["member-x"],
      approvedByMemberId: "admin-1",
    });
  });
});

describe("applicant MAP — keep-auth path (existing login target)", () => {
  it("never touches auth fields, issues no setup token, and sends no set-password email", async () => {
    const targets = [targetRow({ canLogin: true, email: "jane@test.com" })];
    const token = await tokenFor(APPLICANT_MAP, targets, { id: "member-x" });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({ targets, loginHolder: { id: "member-x" } });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await approveMemberApplication(
      "app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token,
    );

    const data = update.mock.calls[0][0].data;
    expect(data.passwordHash).toBeUndefined();
    expect(data.canLogin).toBeUndefined();
    expect(data.emailVerified).toBeUndefined();
    expect(tx.passwordResetToken.create).not.toHaveBeenCalled();
    expect(emailMock.sendMembershipApplicationApprovedEmail).not.toHaveBeenCalled();
    expect(result.warnings).toContain(
      "Applicant mapped to an existing login member; no account-setup email was sent.",
    );
  });

  it("does not regress confirmation timestamps that are already set", async () => {
    const already = new Date("2020-01-01T00:00:00.000Z");
    const targets = [targetRow({
      canLogin: true,
      email: "jane@test.com",
      profileCompletedAt: already,
      detailsConfirmedAt: already,
      detailsConfirmedByMemberId: "member-x",
      onboardingConfirmedAt: already,
    })];
    const token = await tokenFor(APPLICANT_MAP, targets, { id: "member-x" });

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx, update } = makeTx({ targets, loginHolder: { id: "member-x" } });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token);

    const data = update.mock.calls[0][0].data;
    expect(data.profileCompletedAt).toBeUndefined();
    expect(data.detailsConfirmedAt).toBeUndefined();
    expect(data.detailsConfirmedByMemberId).toBeUndefined();
    expect(data.onboardingConfirmedAt).toBeUndefined();
  });
});

describe("token drift + concurrent-approval serialization", () => {
  it("409s a stale/forged token", async () => {
    const targets = [targetRow()];
    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx } = makeTx({ targets, loginHolder: null });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, "not-a-valid-token"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("409s when the locked target's updatedAt advanced since the preview (serialization)", async () => {
    const previewTargets = [targetRow({ updatedAt: new Date("2026-04-10T00:00:00.000Z") })];
    const token = await tokenFor(APPLICANT_MAP, previewTargets, null);

    // The concurrent winner advanced the row: the in-tx reload returns a later
    // updatedAt, so the recomputed token no longer matches.
    const reloadedTargets = [targetRow({ updatedAt: new Date("2026-04-13T00:00:00.000Z") })];
    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx } = makeTx({ targets: reloadedTargets, loginHolder: null });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token),
    ).rejects.toMatchObject({ status: 409 });
    // The application status was never flipped to APPROVED.
    expect(tx.memberApplication.update).not.toHaveBeenCalled();
  });
});

describe("collision + billing policy at approval", () => {
  it("blocks a mapping onto an inactive/archived target even with a valid token", async () => {
    const targets = [targetRow({ active: false })];
    const token = await tokenFor(APPLICANT_MAP, targets, null);

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx } = makeTx({ targets, loginHolder: null });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await expect(
      approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("excludes a skip-with-note target (existing coverage) from subscription billing", async () => {
    const targets = [targetRow({ subscriptions: [{ id: "sub-1" }] })];
    const token = await tokenFor(APPLICANT_MAP, targets, null);

    prismaMock.memberApplication.findUnique.mockResolvedValue(applicationRow() as never);
    const { tx } = makeTx({ targets, loginHolder: null });
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await approveMemberApplication("app-1", "admin-1", null, null, undefined, APPLICANT_MAP, token);

    expect(billingMock.queueApprovedMembershipSubscriptionCharges).toHaveBeenCalledWith({
      memberIds: [],
      approvedByMemberId: "admin-1",
    });
  });
});

describe("family MAP", () => {
  const familyApp = () =>
    applicationRow({
      familyMembers: [{ firstName: "Sam", lastName: "Doe", dateOfBirth: "2018-06-01" }],
    });
  const familyDecisions = {
    applicant: { mode: "CREATE" as const },
    family: [{ mode: "MAP" as const, memberId: "child-x" }],
  };

  it("creates the applicant, overwrites + re-parents the mapped dependent, and joins the group", async () => {
    const childTarget = targetRow({ id: "child-x", canLogin: false, parentMemberId: null });
    // Preview against the family application.
    prismaMock.memberApplication.findUnique.mockResolvedValue(familyApp() as never);
    prismaMock.member.findMany.mockImplementation(findManyFor([childTarget]));
    prismaMock.member.findFirst.mockResolvedValue(null as never);
    const previewResult = await buildApprovalMappingPreview({
      applicationId: "app-1",
      personDecisions: familyDecisions as never,
      seasonYear: 2026,
    });
    const token = (previewResult.body as { preview: { previewToken: string } }).preview.previewToken;

    prismaMock.memberApplication.findUnique.mockResolvedValue(familyApp() as never);
    const { tx, update } = makeTx({ targets: [childTarget], loginHolder: null });
    tx.memberApplication.findUnique.mockResolvedValue(familyApp());
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await approveMemberApplication(
      "app-1", "admin-1", null, null, undefined, familyDecisions, token,
    );

    // Applicant created; dependent updated (re-parented) not created.
    expect(tx.member.create).toHaveBeenCalledTimes(1);
    const depUpdate = update.mock.calls.find((call) => call[0].where.id === "child-x");
    expect(depUpdate?.[0].data).toMatchObject({
      parentMemberId: "member-1",
      inheritParentEmail: true,
      inheritEmailFromId: "member-1",
    });
    expect(tx.familyGroupMember.upsert).toHaveBeenCalled();
    expect(result.createdMemberIds).toEqual(["member-1"]);
    expect(result.mappedMemberIds).toEqual(["child-x"]);
  });
});
