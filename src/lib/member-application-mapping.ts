import "server-only";

import { createHmac, timingSafeEqual } from "crypto";
import type { AgeTier, Prisma } from "@prisma/client";
import { z } from "zod";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { prisma } from "@/lib/prisma";
import {
  parseApplicantPhone,
  parseApplicationAddress,
  parseApplicationFamilyMembers,
  type ApplicationFamilyMember,
} from "@/lib/nomination";

// ---------------------------------------------------------------------------
// E10 (#1936): map membership applicants onto existing member records at
// approval time. Decisions are transient request payloads; only outcomes are
// audited (no schema changes). This module owns the shared, deterministic
// outcome computation used by BOTH the preview endpoint and the in-transaction
// recompute inside approveMemberApplication, plus the HMAC preview token that
// binds an approval to the exact previewed outcome (mirrors the
// seasonal-membership preview token, seasonal-membership-assignments.ts).
// ---------------------------------------------------------------------------

const PREVIEW_TOKEN_VERSION = 1;

export type PersonRef = { kind: "applicant" } | { kind: "family"; index: number };

export type PersonDecisionInput =
  | { mode: "CREATE" }
  | { mode: "MAP"; memberId: string };

export const personDecisionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("CREATE") }),
  z.object({ mode: z.literal("MAP"), memberId: z.string().min(1) }),
]);

export const personDecisionsSchema = z.object({
  applicant: personDecisionSchema,
  family: z.array(personDecisionSchema),
});

export type PersonDecisions = z.infer<typeof personDecisionsSchema>;

export type NormalizedPersonDecision = {
  ref: PersonRef;
  decision: PersonDecisionInput;
};

export type FieldDiff = {
  field: string;
  label: string;
  current: string | null;
  incoming: string | null;
  willChange: boolean;
};

export type MappingTargetSummary = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: AgeTier;
  role: string;
  active: boolean;
  archived: boolean;
  canLogin: boolean;
};

export type CandidateSuggestion = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: AgeTier;
  active: boolean;
  canLogin: boolean;
  score: number;
  matchedOnEmail: boolean;
};

export type PersonOutcome = {
  ref: PersonRef;
  personLabel: string;
  mode: "CREATE" | "MAP";
  targetMemberId: string | null;
  // ISO string of the mapped target's updatedAt, or null. Part of the token so
  // any edit to a mapped row invalidates a stale approval (409, not silent).
  targetUpdatedAt: string | null;
  targetSummary: MappingTargetSummary | null;
  fieldDiffs: FieldDiff[];
  notes: string[];
  errors: string[];
  // Apply-time flags (deterministic from the same inputs the diffs come from).
  loginPromoted: boolean;
  keepAuth: boolean;
  setParentLink: boolean;
  skipSeasonalAssignment: boolean;
};

export type ApprovalMappingPreview = {
  applicationId: string;
  generatedAt: string;
  persons: Array<PersonOutcome & { suggestions: CandidateSuggestion[] }>;
  blockingErrors: string[];
  hasMappings: boolean;
  previewToken: string;
};

export type JsonRouteResult = { body: unknown; init?: ResponseInit };

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init };
}

// ---------------------------------------------------------------------------
// Target loading
// ---------------------------------------------------------------------------

export type MappingApplicationInput = {
  id: string;
  updatedAt: Date;
  applicantEmail: string;
  applicantFirstName: string;
  applicantLastName: string;
  applicantDateOfBirth: Date;
  applicantPhone: string | null;
  applicantAddress: unknown;
  familyMembers: ApplicationFamilyMember[];
  nominator1Id: string | null;
  nominator2Id: string | null;
};

type MappingReadClient = typeof prisma | Prisma.TransactionClient;

export type MappingTargetRecord = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date | null;
  ageTier: AgeTier;
  role: string;
  active: boolean;
  archivedAt: Date | null;
  canLogin: boolean;
  parentMemberId: string | null;
  inheritParentEmail: boolean;
  inheritEmailFromId: string | null;
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
  profileCompletedAt: Date | null;
  detailsConfirmedAt: Date | null;
  detailsConfirmedByMemberId: string | null;
  onboardingConfirmedAt: Date | null;
  xeroContactId: string | null;
  updatedAt: Date;
  familyGroupMemberships: Array<{ familyGroupId: string }>;
  subscriptions: Array<{ id: string }>;
  seasonalMembershipAssignments: Array<{ id: string }>;
};

export async function loadApprovalMappingTargets(
  db: MappingReadClient,
  memberIds: string[],
  seasonYear: number,
): Promise<Map<string, MappingTargetRecord>> {
  if (memberIds.length === 0) {
    return new Map();
  }
  const rows = (await db.member.findMany({
    where: { id: { in: memberIds } },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      ageTier: true,
      role: true,
      active: true,
      archivedAt: true,
      canLogin: true,
      parentMemberId: true,
      inheritParentEmail: true,
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
      profileCompletedAt: true,
      detailsConfirmedAt: true,
      detailsConfirmedByMemberId: true,
      onboardingConfirmedAt: true,
      xeroContactId: true,
      updatedAt: true,
      familyGroupMemberships: { select: { familyGroupId: true } },
      subscriptions: { where: { seasonYear }, select: { id: true }, take: 1 },
      seasonalMembershipAssignments: {
        where: { seasonYear },
        select: { id: true },
        take: 1,
      },
    },
  })) as unknown as MappingTargetRecord[];
  return new Map(rows.map((row) => [row.id, row]));
}

export async function getLoginHolderIdForEmail(
  db: MappingReadClient,
  email: string,
): Promise<string | null> {
  const holder = await db.member.findFirst({
    where: { email, canLogin: true },
    select: { id: true },
  });
  return holder?.id ?? null;
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

function norm(value: unknown): string | null {
  const text = value == null ? "" : String(value).trim();
  return text.length > 0 ? text : null;
}

function makeDiff(
  field: string,
  label: string,
  current: unknown,
  incoming: unknown,
): FieldDiff {
  const c = norm(current);
  const i = norm(incoming);
  return { field, label, current: c, incoming: i, willChange: c !== i };
}

function dateOnly(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

function personRefLabel(ref: PersonRef): string {
  return ref.kind === "applicant" ? "applicant" : `family[${ref.index}]`;
}

function refKey(ref: PersonRef): string {
  return ref.kind === "applicant" ? "applicant" : `family:${ref.index}`;
}

function targetSummary(target: MappingTargetRecord): MappingTargetSummary {
  return {
    id: target.id,
    firstName: target.firstName,
    lastName: target.lastName,
    email: target.email,
    ageTier: target.ageTier,
    role: target.role,
    active: target.active,
    archived: target.archivedAt != null,
    canLogin: target.canLogin,
  };
}

// ---------------------------------------------------------------------------
// Core outcome computation (shared by preview + in-tx recompute)
// ---------------------------------------------------------------------------

export async function computeApprovalMappingOutcomes(params: {
  application: MappingApplicationInput;
  decisions: NormalizedPersonDecision[];
  targetsById: Map<string, MappingTargetRecord>;
  loginHolderId: string | null;
  seasonYear: number;
}): Promise<{ persons: PersonOutcome[]; blockingErrors: string[] }> {
  const { application, decisions, targetsById, loginHolderId, seasonYear } =
    params;
  const seasonStart = getSeasonStartDate(seasonYear);
  const hasFamily = application.familyMembers.length > 0;
  const nominatorIds = new Set(
    [application.nominator1Id, application.nominator2Id].filter(
      (value): value is string => Boolean(value),
    ),
  );

  const applicantPhone = parseApplicantPhone(application.applicantPhone);
  const applicantAddress = parseApplicationAddress(application.applicantAddress);
  const applicantAgeTier = await computeAgeTier(
    application.applicantDateOfBirth,
    seasonStart,
  );

  const persons: PersonOutcome[] = [];

  for (const { ref, decision } of decisions) {
    if (ref.kind === "applicant") {
      const label =
        `${application.applicantFirstName} ${application.applicantLastName}`.trim();
      if (decision.mode === "CREATE") {
        const errors: string[] = [];
        if (loginHolderId) {
          errors.push(
            "An active account with a login already exists for this email address.",
          );
        }
        persons.push(baseCreateOutcome(ref, label, errors));
        continue;
      }
      const target = targetsById.get(decision.memberId);
      persons.push(
        buildApplicantMapOutcome({
          ref,
          label,
          target,
          loginHolderId,
          nominatorIds,
          hasFamily,
          incoming: {
            firstName: application.applicantFirstName,
            lastName: application.applicantLastName,
            dateOfBirth: dateOnly(application.applicantDateOfBirth),
            email: application.applicantEmail,
            phone: applicantPhone,
            address: applicantAddress,
            ageTier: applicantAgeTier,
          },
        }),
      );
      continue;
    }

    const familyMember = application.familyMembers[ref.index];
    const label = familyMember
      ? `${familyMember.firstName} ${familyMember.lastName}`.trim()
      : `Dependent ${ref.index + 1}`;
    if (decision.mode === "CREATE") {
      persons.push(baseCreateOutcome(ref, label, []));
      continue;
    }
    const target = targetsById.get(decision.memberId);
    const familyAgeTier = familyMember
      ? await computeAgeTier(new Date(familyMember.dateOfBirth), seasonStart)
      : "ADULT";
    persons.push(
      buildFamilyMapOutcome({
        ref,
        label,
        target,
        nominatorIds,
        incoming: {
          firstName: familyMember?.firstName ?? "",
          lastName: familyMember?.lastName ?? "",
          dateOfBirth: familyMember?.dateOfBirth ?? null,
          // Dependents inherit the applicant's phone + address (create path).
          phone: applicantPhone,
          address: applicantAddress,
          ageTier: familyAgeTier,
        },
      }),
    );
  }

  // Cross-person: the same existing member must not be mapped to two people.
  const blockingErrors: string[] = [];
  const targetCounts = new Map<string, number>();
  for (const person of persons) {
    if (person.targetMemberId) {
      targetCounts.set(
        person.targetMemberId,
        (targetCounts.get(person.targetMemberId) ?? 0) + 1,
      );
    }
  }
  const duplicated = [...targetCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([memberId]) => memberId)
    .sort();
  for (const memberId of duplicated) {
    blockingErrors.push(
      `The same existing member (${memberId}) cannot be mapped to more than one person on this application.`,
    );
  }

  return { persons, blockingErrors };
}

function baseCreateOutcome(
  ref: PersonRef,
  personLabel: string,
  errors: string[],
): PersonOutcome {
  return {
    ref,
    personLabel,
    mode: "CREATE",
    targetMemberId: null,
    targetUpdatedAt: null,
    targetSummary: null,
    fieldDiffs: [],
    notes: [],
    errors,
    loginPromoted: false,
    keepAuth: false,
    setParentLink: false,
    skipSeasonalAssignment: false,
  };
}

type ApplicantIncoming = {
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  email: string;
  phone: {
    phoneCountryCode: string | null;
    phoneAreaCode: string | null;
    phoneNumber: string | null;
  };
  address: Record<string, string | null | boolean>;
  ageTier: AgeTier;
};

function buildApplicantMapOutcome(args: {
  ref: PersonRef;
  label: string;
  target: MappingTargetRecord | undefined;
  loginHolderId: string | null;
  nominatorIds: Set<string>;
  hasFamily: boolean;
  incoming: ApplicantIncoming;
}): PersonOutcome {
  const { ref, label, target, loginHolderId, nominatorIds, hasFamily, incoming } =
    args;
  if (!target) {
    return {
      ...baseCreateOutcome(ref, label, [
        "Selected member record not found. Refresh the preview.",
      ]),
      mode: "MAP",
    };
  }

  const errors: string[] = [];
  const notes: string[] = [];

  if (!target.active || target.archivedAt) {
    errors.push("Cannot map to an inactive or archived member.");
  }
  // Relax the create-path canLogin-email 409 ONLY when the login-holder IS the
  // mapped target; a different login-holder still blocks.
  if (loginHolderId && loginHolderId !== target.id) {
    errors.push(
      "The application email is already used by a different member who can log in.",
    );
  }
  if (nominatorIds.has(target.id)) {
    errors.push(
      "This member is a nominator on this application and cannot be mapped as the applicant.",
    );
  }
  if (hasFamily && target.familyGroupMemberships.length > 0) {
    errors.push(
      "This member already belongs to a family group and cannot join the new application family group.",
    );
  }

  const fieldDiffs = buildApplicantDiffs(target, incoming);

  const keepAuth = target.canLogin === true;
  const loginPromoted = target.canLogin === false;
  const skipSeasonalAssignment =
    target.subscriptions.length > 0 ||
    target.seasonalMembershipAssignments.length > 0;

  if (keepAuth) {
    notes.push(
      "Existing login is preserved: password, login access, and two-factor settings are left untouched.",
    );
  } else {
    notes.push(
      "This member will be promoted to a login account (a set-password email will be sent).",
    );
  }
  if (skipSeasonalAssignment) {
    notes.push(
      "Keeps existing season membership coverage; no new subscription charge will be raised.",
    );
  }

  return {
    ref,
    personLabel: label,
    mode: "MAP",
    targetMemberId: target.id,
    targetUpdatedAt: target.updatedAt.toISOString(),
    targetSummary: targetSummary(target),
    fieldDiffs,
    notes,
    errors,
    loginPromoted,
    keepAuth,
    setParentLink: false,
    skipSeasonalAssignment,
  };
}

function buildApplicantDiffs(
  target: MappingTargetRecord,
  incoming: ApplicantIncoming,
): FieldDiff[] {
  return [
    makeDiff("firstName", "First name", target.firstName, incoming.firstName),
    makeDiff("lastName", "Last name", target.lastName, incoming.lastName),
    makeDiff(
      "dateOfBirth",
      "Date of birth",
      dateOnly(target.dateOfBirth),
      incoming.dateOfBirth,
    ),
    makeDiff("email", "Email", target.email, incoming.email),
    ...phoneDiffs(target, incoming.phone),
    ...addressDiffs(target, incoming.address),
    makeDiff("ageTier", "Age tier", target.ageTier, incoming.ageTier),
  ];
}

type FamilyIncoming = {
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  phone: ApplicantIncoming["phone"];
  address: ApplicantIncoming["address"];
  ageTier: AgeTier;
};

function buildFamilyMapOutcome(args: {
  ref: PersonRef;
  label: string;
  target: MappingTargetRecord | undefined;
  nominatorIds: Set<string>;
  incoming: FamilyIncoming;
}): PersonOutcome {
  const { ref, label, target, nominatorIds, incoming } = args;
  if (!target) {
    return {
      ...baseCreateOutcome(ref, label, [
        "Selected member record not found. Refresh the preview.",
      ]),
      mode: "MAP",
    };
  }

  const errors: string[] = [];
  const notes: string[] = [];

  if (!target.active || target.archivedAt) {
    errors.push("Cannot map to an inactive or archived member.");
  }
  if (target.role === "ADMIN") {
    errors.push("An admin member cannot be mapped as a dependent.");
  }
  if (nominatorIds.has(target.id)) {
    errors.push(
      "This member is a nominator on this application and cannot be mapped as a dependent.",
    );
  }
  // A family application always forms a new family group.
  if (target.familyGroupMemberships.length > 0) {
    errors.push(
      "This member already belongs to a family group and cannot join the new application family group.",
    );
  }

  const fieldDiffs = [
    makeDiff("firstName", "First name", target.firstName, incoming.firstName),
    makeDiff("lastName", "Last name", target.lastName, incoming.lastName),
    makeDiff(
      "dateOfBirth",
      "Date of birth",
      dateOnly(target.dateOfBirth),
      incoming.dateOfBirth,
    ),
    ...phoneDiffs(target, incoming.phone),
    ...addressDiffs(target, incoming.address),
    makeDiff("ageTier", "Age tier", target.ageTier, incoming.ageTier),
  ];

  // Parent link / email inheritance only when target is non-login with no
  // existing parent; otherwise preserve and note it.
  const setParentLink =
    target.canLogin === false && target.parentMemberId == null;
  if (!setParentLink) {
    if (target.canLogin) {
      notes.push(
        "This member can log in, so their email and parent link are left untouched.",
      );
    } else if (target.parentMemberId != null) {
      notes.push(
        "This member already has a parent link, which is left untouched.",
      );
    }
  }

  const skipSeasonalAssignment =
    target.subscriptions.length > 0 ||
    target.seasonalMembershipAssignments.length > 0;
  if (skipSeasonalAssignment) {
    notes.push(
      "Keeps existing season membership coverage; no new subscription charge will be raised.",
    );
  }

  return {
    ref,
    personLabel: label,
    mode: "MAP",
    targetMemberId: target.id,
    targetUpdatedAt: target.updatedAt.toISOString(),
    targetSummary: targetSummary(target),
    fieldDiffs,
    notes,
    errors,
    loginPromoted: false,
    keepAuth: target.canLogin === true,
    setParentLink,
    skipSeasonalAssignment,
  };
}

function phoneDiffs(
  target: MappingTargetRecord,
  phone: ApplicantIncoming["phone"],
): FieldDiff[] {
  return [
    makeDiff(
      "phoneCountryCode",
      "Phone country code",
      target.phoneCountryCode,
      phone.phoneCountryCode,
    ),
    makeDiff(
      "phoneAreaCode",
      "Phone area code",
      target.phoneAreaCode,
      phone.phoneAreaCode,
    ),
    makeDiff("phoneNumber", "Phone number", target.phoneNumber, phone.phoneNumber),
  ];
}

const ADDRESS_FIELDS: Array<{ field: keyof MappingTargetRecord; label: string }> =
  [
    { field: "streetAddressLine1", label: "Street address line 1" },
    { field: "streetAddressLine2", label: "Street address line 2" },
    { field: "streetCity", label: "Street city" },
    { field: "streetRegion", label: "Street region" },
    { field: "streetPostalCode", label: "Street postal code" },
    { field: "streetCountry", label: "Street country" },
    { field: "postalAddressLine1", label: "Postal address line 1" },
    { field: "postalAddressLine2", label: "Postal address line 2" },
    { field: "postalCity", label: "Postal city" },
    { field: "postalRegion", label: "Postal region" },
    { field: "postalPostalCode", label: "Postal postal code" },
    { field: "postalCountry", label: "Postal country" },
  ];

function addressDiffs(
  target: MappingTargetRecord,
  address: ApplicantIncoming["address"],
): FieldDiff[] {
  return ADDRESS_FIELDS.map(({ field, label }) =>
    makeDiff(field, label, target[field], address[field]),
  );
}

// ---------------------------------------------------------------------------
// Preview token (HMAC over the full per-person outcome payload + updatedAts)
// ---------------------------------------------------------------------------

function getPreviewSecret(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET or NEXTAUTH_SECRET is required for member application mapping preview tokens",
    );
  }
  return "member-application-mapping-preview-local-secret";
}

export type ApprovalMappingTokenPayload = {
  application: MappingApplicationInput;
  persons: PersonOutcome[];
  blockingErrors: string[];
};

function previewTokenPayload(input: ApprovalMappingTokenPayload) {
  return {
    version: PREVIEW_TOKEN_VERSION,
    applicationId: input.application.id,
    applicationUpdatedAt: input.application.updatedAt.toISOString(),
    persons: input.persons.map((person) => ({
      ref: person.ref,
      mode: person.mode,
      targetMemberId: person.targetMemberId,
      targetUpdatedAt: person.targetUpdatedAt,
      fieldDiffs: person.fieldDiffs,
      notes: person.notes,
      errors: person.errors,
      loginPromoted: person.loginPromoted,
      keepAuth: person.keepAuth,
      setParentLink: person.setParentLink,
      skipSeasonalAssignment: person.skipSeasonalAssignment,
    })),
    blockingErrors: input.blockingErrors,
  };
}

export function buildApprovalMappingPreviewToken(
  input: ApprovalMappingTokenPayload,
): string {
  return createHmac("sha256", getPreviewSecret())
    .update(JSON.stringify(previewTokenPayload(input)))
    .digest("hex");
}

export function verifyApprovalMappingPreviewToken(
  input: ApprovalMappingTokenPayload,
  token: string,
): boolean {
  const expected = buildApprovalMappingPreviewToken(input);
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);
  return (
    expectedBuffer.length === tokenBuffer.length &&
    timingSafeEqual(expectedBuffer, tokenBuffer)
  );
}

// ---------------------------------------------------------------------------
// Decision normalization
// ---------------------------------------------------------------------------

export type DecisionResolution =
  | { ok: true; decisions: NormalizedPersonDecision[]; mapTargetIds: string[] }
  | { ok: false; status: number; error: string };

/**
 * Normalize the per-person decisions against the application's family shape.
 * Absent decisions default to all-CREATE (byte-identical current behavior).
 */
export function resolvePersonDecisions(
  familyCount: number,
  personDecisions: PersonDecisions | null | undefined,
): DecisionResolution {
  if (!personDecisions) {
    const decisions: NormalizedPersonDecision[] = [
      { ref: { kind: "applicant" }, decision: { mode: "CREATE" } },
      ...Array.from({ length: familyCount }, (_, index) => ({
        ref: { kind: "family" as const, index },
        decision: { mode: "CREATE" as const },
      })),
    ];
    return { ok: true, decisions, mapTargetIds: [] };
  }

  if (personDecisions.family.length !== familyCount) {
    return {
      ok: false,
      status: 422,
      error: `Family decision count (${personDecisions.family.length}) does not match the application's ${familyCount} family member(s).`,
    };
  }

  const decisions: NormalizedPersonDecision[] = [
    { ref: { kind: "applicant" }, decision: personDecisions.applicant },
    ...personDecisions.family.map((decision, index) => ({
      ref: { kind: "family" as const, index },
      decision,
    })),
  ];

  const mapTargetIds = decisions
    .map(({ decision }) => (decision.mode === "MAP" ? decision.memberId : null))
    .filter((value): value is string => Boolean(value));

  return { ok: true, decisions, mapTargetIds: [...new Set(mapTargetIds)].sort() };
}

// ---------------------------------------------------------------------------
// Candidate suggestions (advisory; NOT part of the token)
// ---------------------------------------------------------------------------

async function suggestCandidates(
  db: MappingReadClient,
  input: { email?: string | null; firstName: string; lastName: string },
): Promise<CandidateSuggestion[]> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const email = input.email?.trim().toLowerCase() || null;
  if (!firstName && !lastName && !email) {
    return [];
  }

  const orClauses: Prisma.MemberWhereInput[] = [];
  if (email) {
    orClauses.push({ email: { equals: email, mode: "insensitive" } });
  }
  if (firstName && lastName) {
    orClauses.push({
      AND: [
        { firstName: { contains: firstName, mode: "insensitive" } },
        { lastName: { contains: lastName, mode: "insensitive" } },
      ],
    });
  }
  if (orClauses.length === 0) {
    return [];
  }

  const rows = await db.member.findMany({
    where: { archivedAt: null, OR: orClauses },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      ageTier: true,
      active: true,
      canLogin: true,
    },
    take: 12,
  });

  return rows
    .map((row) => {
      const matchedOnEmail = Boolean(
        email && row.email.trim().toLowerCase() === email,
      );
      const nameExact =
        row.firstName.trim().toLowerCase() === firstName.toLowerCase() &&
        row.lastName.trim().toLowerCase() === lastName.toLowerCase();
      let score = 0;
      if (matchedOnEmail) score += 100;
      if (nameExact) score += 60;
      else score += 20;
      return { ...row, score, matchedOnEmail };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.lastName.localeCompare(b.lastName) ||
        a.firstName.localeCompare(b.firstName),
    )
    .slice(0, 5);
}

// ---------------------------------------------------------------------------
// Preview endpoint entrypoint
// ---------------------------------------------------------------------------

export async function buildApprovalMappingPreview(params: {
  applicationId: string;
  personDecisions?: PersonDecisions | null;
  seasonYear: number;
  db?: MappingReadClient;
}): Promise<JsonRouteResult> {
  const db = params.db ?? prisma;
  const application = await db.memberApplication.findUnique({
    where: { id: params.applicationId },
  });
  if (!application) {
    return jsonResult({ error: "Application not found" }, { status: 404 });
  }
  if (!application.applicantDateOfBirth) {
    return jsonResult(
      { error: "Applicant date of birth is required before approval" },
      { status: 409 },
    );
  }

  const familyMembers = parseApplicationFamilyMembers(application.familyMembers);
  const resolution = resolvePersonDecisions(
    familyMembers.length,
    params.personDecisions,
  );
  if (!resolution.ok) {
    return jsonResult({ error: resolution.error }, { status: resolution.status });
  }

  const applicationInput: MappingApplicationInput = {
    id: application.id,
    updatedAt: application.updatedAt,
    applicantEmail: application.applicantEmail,
    applicantFirstName: application.applicantFirstName,
    applicantLastName: application.applicantLastName,
    applicantDateOfBirth: application.applicantDateOfBirth,
    applicantPhone: application.applicantPhone,
    applicantAddress: application.applicantAddress,
    familyMembers,
    nominator1Id: application.nominator1Id,
    nominator2Id: application.nominator2Id,
  };

  const [targetsById, loginHolderId] = await Promise.all([
    loadApprovalMappingTargets(db, resolution.mapTargetIds, params.seasonYear),
    getLoginHolderIdForEmail(db, application.applicantEmail),
  ]);

  const { persons, blockingErrors } = await computeApprovalMappingOutcomes({
    application: applicationInput,
    decisions: resolution.decisions,
    targetsById,
    loginHolderId,
    seasonYear: params.seasonYear,
  });

  const previewToken = buildApprovalMappingPreviewToken({
    application: applicationInput,
    persons,
    blockingErrors,
  });

  // Suggestions are advisory (ranked exact-email first) and intentionally
  // excluded from the token so unrelated member edits never invalidate an
  // approval.
  const personSuggestions = await Promise.all(
    persons.map(async (person) => {
      if (person.ref.kind === "applicant") {
        return suggestCandidates(db, {
          email: application.applicantEmail,
          firstName: application.applicantFirstName,
          lastName: application.applicantLastName,
        });
      }
      const familyMember = familyMembers[person.ref.index];
      return suggestCandidates(db, {
        email: null,
        firstName: familyMember?.firstName ?? "",
        lastName: familyMember?.lastName ?? "",
      });
    }),
  );

  const preview: ApprovalMappingPreview = {
    applicationId: application.id,
    generatedAt: new Date().toISOString(),
    persons: persons.map((person, index) => ({
      ...person,
      suggestions: personSuggestions[index],
    })),
    blockingErrors,
    hasMappings: resolution.mapTargetIds.length > 0,
    previewToken,
  };

  return jsonResult({ preview });
}

export { refKey, personRefLabel };
