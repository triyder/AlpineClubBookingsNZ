import { beforeEach, describe, expect, it, vi } from "vitest";

// E10 (#1936): unit tests for the shared mapping engine — deterministic
// per-person outcome computation, the HMAC preview token (row + outcome drift),
// the collision policy, and ranked candidate suggestions.

const { prismaMock, ageTierMock } = vi.hoisted(() => ({
  prismaMock: {
    memberApplication: { findUnique: vi.fn() },
    member: { findMany: vi.fn(), findFirst: vi.fn() },
  },
  ageTierMock: {
    computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
    getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01T00:00:00.000Z")),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/age-tier", () => ageTierMock);
vi.mock("@/lib/utils", () => ({ getSeasonYear: vi.fn().mockReturnValue(2026) }));
vi.mock("@/lib/email", () => ({}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroEntranceFeeInvoiceOperation: vi.fn(),
  processQueuedXeroOutboxOperations: vi.fn(),
}));
vi.mock("@/lib/membership-subscription-billing", () => ({
  queueApprovedMembershipSubscriptionCharges: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/induction", () => ({ createMemberInduction: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed") }));

import {
  buildApprovalMappingPreview,
  buildApprovalMappingPreviewToken,
  computeApprovalMappingOutcomes,
  verifyApprovalMappingPreviewToken,
  type MappingApplicationInput,
  type MappingTargetRecord,
} from "@/lib/member-application-mapping";
import type { NormalizedPersonDecision } from "@/lib/member-application-decisions";

function makeApplication(
  overrides: Partial<MappingApplicationInput> = {},
): MappingApplicationInput {
  return {
    id: "app-1",
    updatedAt: new Date("2026-04-12T00:00:00.000Z"),
    applicantEmail: "jane@test.com",
    applicantFirstName: "Jane",
    applicantLastName: "Doe",
    applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
    applicantPhone: "64 21 5551234",
    applicantAddress: null,
    familyMembers: [],
    nominator1Id: "nom-1",
    nominator2Id: "nom-2",
    ...overrides,
  };
}

function makeTarget(overrides: Partial<MappingTargetRecord> = {}): MappingTargetRecord {
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

const applicantMapDecisions = (memberId: string): NormalizedPersonDecision[] => [
  { ref: { kind: "applicant" }, decision: { mode: "MAP", memberId } },
];

beforeEach(() => {
  vi.clearAllMocks();
  ageTierMock.computeAgeTier.mockResolvedValue("ADULT");
});

describe("computeApprovalMappingOutcomes — applicant MAP", () => {
  it("diffs name/email, flags promotion, and blocks a foreign login holder", async () => {
    const target = makeTarget({ id: "member-x", canLogin: false });
    const { persons } = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", target]]),
      loginHolderId: "someone-else",
      seasonYear: 2026,
    });
    const applicant = persons[0];
    expect(applicant.mode).toBe("MAP");
    expect(applicant.loginPromoted).toBe(true);
    expect(applicant.keepAuth).toBe(false);
    const emailDiff = applicant.fieldDiffs.find((diff) => diff.field === "email");
    expect(emailDiff).toMatchObject({ current: "old@test.com", incoming: "jane@test.com", willChange: true });
    expect(applicant.errors).toContain(
      "The application email is already used by a different member who can log in.",
    );
  });

  it("relaxes the login-email guard when the login holder IS the target (keep-auth)", async () => {
    const target = makeTarget({ id: "member-x", canLogin: true, email: "jane@test.com" });
    const { persons } = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", target]]),
      loginHolderId: "member-x",
      seasonYear: 2026,
    });
    expect(persons[0].errors).toEqual([]);
    expect(persons[0].keepAuth).toBe(true);
    expect(persons[0].loginPromoted).toBe(false);
  });

  it("blocks mapping to a nominator, an inactive/archived member, and an already-grouped member", async () => {
    const nominatorTarget = makeTarget({ id: "nom-1" });
    const nominatorOutcome = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("nom-1"),
      targetsById: new Map([["nom-1", nominatorTarget]]),
      loginHolderId: null,
      seasonYear: 2026,
    });
    expect(nominatorOutcome.persons[0].errors.join(" ")).toContain("nominator");

    const inactive = makeTarget({ id: "m-inactive", active: false });
    const inactiveOutcome = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("m-inactive"),
      targetsById: new Map([["m-inactive", inactive]]),
      loginHolderId: null,
      seasonYear: 2026,
    });
    expect(inactiveOutcome.persons[0].errors.join(" ")).toContain("inactive or archived");

    const grouped = makeTarget({ id: "m-grouped", familyGroupMemberships: [{ familyGroupId: "fg-9" }] });
    const groupedOutcome = await computeApprovalMappingOutcomes({
      application: makeApplication({
        familyMembers: [{ firstName: "Sam", lastName: "Doe", dateOfBirth: "2018-06-01" }],
      }),
      decisions: [
        { ref: { kind: "applicant" }, decision: { mode: "MAP", memberId: "m-grouped" } },
        { ref: { kind: "family", index: 0 }, decision: { mode: "CREATE" } },
      ],
      targetsById: new Map([["m-grouped", grouped]]),
      loginHolderId: null,
      seasonYear: 2026,
    });
    expect(groupedOutcome.persons[0].errors.join(" ")).toContain("already belongs to a family group");
  });

  it("skips billing with a note when the target already has season coverage", async () => {
    const target = makeTarget({ id: "member-x", subscriptions: [{ id: "sub-1" }] });
    const { persons } = await computeApprovalMappingOutcomes({
      application: makeApplication(),
      decisions: applicantMapDecisions("member-x"),
      targetsById: new Map([["member-x", target]]),
      loginHolderId: null,
      seasonYear: 2026,
    });
    expect(persons[0].skipSeasonalAssignment).toBe(true);
    expect(persons[0].notes.join(" ")).toContain("existing season membership coverage");
  });
});

describe("computeApprovalMappingOutcomes — family MAP", () => {
  const familyApp = () =>
    makeApplication({
      familyMembers: [{ firstName: "Sam", lastName: "Doe", dateOfBirth: "2018-06-01" }],
    });
  const familyDecisions = (memberId: string): NormalizedPersonDecision[] => [
    { ref: { kind: "applicant" }, decision: { mode: "CREATE" } },
    { ref: { kind: "family", index: 0 }, decision: { mode: "MAP", memberId } },
  ];

  it("blocks an ADMIN member mapped as a dependent", async () => {
    const admin = makeTarget({ id: "m-admin", role: "ADMIN" });
    const { persons } = await computeApprovalMappingOutcomes({
      application: familyApp(),
      decisions: familyDecisions("m-admin"),
      targetsById: new Map([["m-admin", admin]]),
      loginHolderId: null,
      seasonYear: 2026,
    });
    expect(persons[1].errors.join(" ")).toContain("admin member cannot be mapped as a dependent");
  });

  it("sets the parent link only for a non-login target with no parent; notes otherwise", async () => {
    const fresh = makeTarget({ id: "m-fresh", canLogin: false, parentMemberId: null });
    const freshOutcome = await computeApprovalMappingOutcomes({
      application: familyApp(),
      decisions: familyDecisions("m-fresh"),
      targetsById: new Map([["m-fresh", fresh]]),
      loginHolderId: null,
      seasonYear: 2026,
    });
    expect(freshOutcome.persons[1].setParentLink).toBe(true);

    const loginable = makeTarget({ id: "m-login", canLogin: true });
    const loginableOutcome = await computeApprovalMappingOutcomes({
      application: familyApp(),
      decisions: familyDecisions("m-login"),
      targetsById: new Map([["m-login", loginable]]),
      loginHolderId: null,
      seasonYear: 2026,
    });
    expect(loginableOutcome.persons[1].setParentLink).toBe(false);
    expect(loginableOutcome.persons[1].notes.join(" ")).toContain("left untouched");
  });

  it("blocks the same member mapped to two people (duplicate target)", async () => {
    const target = makeTarget({ id: "dup" });
    const { blockingErrors } = await computeApprovalMappingOutcomes({
      application: familyApp(),
      decisions: [
        { ref: { kind: "applicant" }, decision: { mode: "MAP", memberId: "dup" } },
        { ref: { kind: "family", index: 0 }, decision: { mode: "MAP", memberId: "dup" } },
      ],
      targetsById: new Map([["dup", target]]),
      loginHolderId: null,
      seasonYear: 2026,
    });
    expect(blockingErrors.join(" ")).toContain("cannot be mapped to more than one person");
  });
});

describe("preview token drift", () => {
  it("verifies a matching payload and rejects row-level and outcome-only drift", async () => {
    const application = makeApplication();
    const decisions = applicantMapDecisions("member-x");
    const target = makeTarget({ id: "member-x" });

    const base = await computeApprovalMappingOutcomes({
      application,
      decisions,
      targetsById: new Map([["member-x", target]]),
      loginHolderId: null,
      seasonYear: 2026,
    });
    const token = buildApprovalMappingPreviewToken({
      application,
      persons: base.persons,
      blockingErrors: base.blockingErrors,
    });
    expect(
      verifyApprovalMappingPreviewToken(
        { application, persons: base.persons, blockingErrors: base.blockingErrors },
        token,
      ),
    ).toBe(true);

    // Row-level drift: the target's updatedAt advances.
    const editedTarget = makeTarget({
      id: "member-x",
      updatedAt: new Date("2026-04-11T00:00:00.000Z"),
    });
    const rowDrift = await computeApprovalMappingOutcomes({
      application,
      decisions,
      targetsById: new Map([["member-x", editedTarget]]),
      loginHolderId: null,
      seasonYear: 2026,
    });
    expect(
      verifyApprovalMappingPreviewToken(
        { application, persons: rowDrift.persons, blockingErrors: rowDrift.blockingErrors },
        token,
      ),
    ).toBe(false);

    // Outcome-only drift: neither row changed, but the recomputed age tier does
    // (e.g. an AgeTierSetting boundary edit).
    ageTierMock.computeAgeTier.mockResolvedValue("YOUTH");
    const outcomeDrift = await computeApprovalMappingOutcomes({
      application,
      decisions,
      targetsById: new Map([["member-x", target]]),
      loginHolderId: null,
      seasonYear: 2026,
    });
    expect(
      verifyApprovalMappingPreviewToken(
        { application, persons: outcomeDrift.persons, blockingErrors: outcomeDrift.blockingErrors },
        token,
      ),
    ).toBe(false);
  });
});

describe("buildApprovalMappingPreview — suggestions", () => {
  it("ranks an exact email match ahead of a name-only match", async () => {
    prismaMock.memberApplication.findUnique.mockResolvedValue({
      id: "app-1",
      updatedAt: new Date("2026-04-12T00:00:00.000Z"),
      applicantEmail: "jane@test.com",
      applicantFirstName: "Jane",
      applicantLastName: "Doe",
      applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
      applicantPhone: "64 21 5551234",
      applicantAddress: null,
      familyMembers: [],
      nominator1Id: null,
      nominator2Id: null,
    });
    prismaMock.member.findFirst.mockResolvedValue(null); // no login holder
    // Suggestions query (applicant person).
    prismaMock.member.findMany.mockResolvedValue([
      { id: "name-only", firstName: "Jane", lastName: "Doe", email: "different@test.com", ageTier: "ADULT", active: true, canLogin: true },
      { id: "email-hit", firstName: "Janet", lastName: "Doering", email: "jane@test.com", ageTier: "ADULT", active: true, canLogin: true },
    ]);

    const result = await buildApprovalMappingPreview({
      applicationId: "app-1",
      personDecisions: null,
      seasonYear: 2026,
    });
    const body = result.body as {
      preview: { persons: Array<{ suggestions: Array<{ id: string; matchedOnEmail: boolean }> }>; hasMappings: boolean };
    };
    expect(body.preview.hasMappings).toBe(false);
    expect(body.preview.persons[0].suggestions[0]).toMatchObject({ id: "email-hit", matchedOnEmail: true });
  });
});
