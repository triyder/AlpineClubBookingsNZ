import "server-only";

import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import { ApplicationStatus, AgeTier, type MemberApplication } from "@prisma/client";
import { z } from "zod";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { logAudit } from "@/lib/audit";
import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import {
  sendAdminMembershipApplicationPendingEmail,
  sendInductionSignOffRequestEmail,
  sendMembershipApplicationApprovedEmail,
  sendMembershipApplicationRejectedEmail,
  sendNominationRequestEmail,
} from "@/lib/email";
import { createMemberInduction } from "@/lib/induction";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import logger from "@/lib/logger";
import { copyStreetAddressToPostal } from "@/lib/member-address";
import { checkNominatorEligibility } from "@/lib/nominator-eligibility";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import { queueApprovedMembershipSubscriptionCharges } from "@/lib/membership-subscription-billing";
import { MEMBER_LEVEL_ROLE_VALUES } from "@/lib/member-roles";
import {
  findOrCreateXeroContact,
  isXeroConnected,
} from "@/lib/xero";
import {
  enqueueXeroEntranceFeeInvoiceOperation,
  processQueuedXeroOutboxOperations,
} from "@/lib/xero-operation-outbox";
import { nameField } from "@/lib/zod-helpers";
import { CLUB_NAME } from "@/config/club-identity";
import {
  NOMINATION_AUTOMATIC_REMINDER_LIMIT,
  getNominationTokenExpiryDate,
} from "@/lib/nomination-token-policy";

const maxStr = (len: number) => z.string().max(len).optional().nullable();
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format");

const applicationAddressSchema = z.object({
  streetAddressLine1: maxStr(200),
  streetAddressLine2: maxStr(200),
  streetCity: maxStr(200),
  streetRegion: maxStr(200),
  streetPostalCode: maxStr(20),
  streetCountry: maxStr(100),
  postalAddressLine1: maxStr(200),
  postalAddressLine2: maxStr(200),
  postalCity: maxStr(200),
  postalRegion: maxStr(200),
  postalPostalCode: maxStr(20),
  postalCountry: maxStr(100),
  postalSameAsPhysical: z.boolean().optional(),
});

const familyMemberSchema = z.object({
  firstName: nameField(),
  lastName: nameField(),
  dateOfBirth: isoDateSchema,
});

export type ApplicationAddress = z.infer<typeof applicationAddressSchema>;
export type ApplicationFamilyMember = z.infer<typeof familyMemberSchema>;

export interface CreateMemberApplicationInput {
  applicantFirstName: string;
  applicantLastName: string;
  applicantEmail: string;
  applicantDateOfBirth?: string | null;
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
  address: ApplicationAddress;
  familyMembers: ApplicationFamilyMember[];
  nominator1Email: string;
  nominator2Email: string;
}

export class MembershipApplicationError extends Error {
  status: number;
  details?: Record<string, string[]>;

  constructor(message: string, status = 400, details?: Record<string, string[]>) {
    super(message);
    this.name = "MembershipApplicationError";
    this.status = status;
    this.details = details;
  }
}

interface VerifiedNominator {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

type MembershipApplicationLookupClient = Pick<
  typeof prisma,
  "member" | "memberApplication"
>;

type MembershipApplicationLockClient = Pick<typeof prisma, "$executeRaw">;

export type EntranceFeeInvoiceApprovalDecision =
  | {
      action: "CREATE";
      amountCents?: number | null;
      narration?: string | null;
    }
  | {
      action: "SKIP";
      reason: string;
    };

export type NominatorSlot = "nominator1" | "nominator2";

function cleanString(value?: string | null) {
  return value?.replace(/[\r\n]/g, " ").trim() || "";
}

function cleanNullableString(value?: string | null) {
  const trimmed = cleanString(value);
  return trimmed || null;
}

function appendPostApprovalWarnings(
  adminNotes: string | null | undefined,
  warnings: string[]
) {
  if (warnings.length === 0) {
    return cleanNullableString(adminNotes);
  }

  const warningBlock = [
    "Post-approval follow-up warnings:",
    ...warnings.map((warning) => `- ${warning}`),
  ].join("\n");
  const existingNotes = cleanNullableString(adminNotes);

  return existingNotes
    ? `${existingNotes}\n\n${warningBlock}`
    : warningBlock;
}

function serializeApplicantPhone(parts: {
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
}) {
  return [parts.phoneCountryCode, parts.phoneAreaCode, parts.phoneNumber]
    .map((part) => cleanString(part))
    .filter(Boolean)
    .join(" ") || null;
}

function parseApplicantPhone(phone: string | null) {
  const trimmed = cleanNullableString(phone);
  if (!trimmed) {
    return {
      phoneCountryCode: null,
      phoneAreaCode: null,
      phoneNumber: null,
    };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length >= 3) {
    return {
      phoneCountryCode: parts[0] || null,
      phoneAreaCode: parts[1] || null,
      phoneNumber: parts.slice(2).join(" ") || null,
    };
  }

  return {
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: trimmed,
  };
}

export function parseApplicationAddress(raw: unknown): ApplicationAddress {
  if (raw == null) {
    return {
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
      postalSameAsPhysical: false,
    };
  }

  const parsed = applicationAddressSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MembershipApplicationError("Stored application address is invalid", 500);
  }

  const {
    streetAddressLine1,
    streetAddressLine2,
    streetCity,
    streetRegion,
    streetPostalCode,
    streetCountry,
    postalAddressLine1,
    postalAddressLine2,
    postalCity,
    postalRegion,
    postalPostalCode,
    postalCountry,
    postalSameAsPhysical,
  } = parsed.data;

  const normalized = {
    streetAddressLine1: cleanNullableString(streetAddressLine1),
    streetAddressLine2: cleanNullableString(streetAddressLine2),
    streetCity: cleanNullableString(streetCity),
    streetRegion: cleanNullableString(streetRegion),
    streetPostalCode: cleanNullableString(streetPostalCode),
    streetCountry: cleanNullableString(streetCountry),
    postalAddressLine1: cleanNullableString(postalAddressLine1),
    postalAddressLine2: cleanNullableString(postalAddressLine2),
    postalCity: cleanNullableString(postalCity),
    postalRegion: cleanNullableString(postalRegion),
    postalPostalCode: cleanNullableString(postalPostalCode),
    postalCountry: cleanNullableString(postalCountry),
    postalSameAsPhysical: Boolean(postalSameAsPhysical),
  };

  if (normalized.postalSameAsPhysical) {
    return {
      ...normalized,
      ...copyStreetAddressToPostal({
        streetAddressLine1: normalized.streetAddressLine1,
        streetAddressLine2: normalized.streetAddressLine2,
        streetCity: normalized.streetCity,
        streetRegion: normalized.streetRegion,
        streetPostalCode: normalized.streetPostalCode,
        streetCountry: normalized.streetCountry,
      }),
    };
  }

  return normalized;
}

export function parseApplicationFamilyMembers(raw: unknown): ApplicationFamilyMember[] {
  if (raw == null) {
    return [];
  }

  const parsed = z.array(familyMemberSchema).safeParse(raw);
  if (!parsed.success) {
    throw new MembershipApplicationError("Stored family member details are invalid", 500);
  }

  return parsed.data.map((member) => ({
    firstName: cleanString(member.firstName),
    lastName: cleanString(member.lastName),
    dateOfBirth: member.dateOfBirth,
  }));
}

async function computeTier(dateOfBirth?: string | null) {
  if (!dateOfBirth) {
    return AgeTier.ADULT;
  }

  return computeAgeTier(new Date(dateOfBirth), getSeasonStartDate(getSeasonYear()));
}

async function verifyNominator(email: string): Promise<VerifiedNominator> {
  const seasonYear = getSeasonYear();
  const normalizedEmail = cleanString(email).toLowerCase();

  const nominator = await prisma.member.findFirst({
    where: {
      email: normalizedEmail,
      active: true,
      canLogin: true,
      role: { in: [...MEMBER_LEVEL_ROLE_VALUES, "ADMIN"] },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      joinedDate: true,
      createdAt: true,
      subscriptions: {
        where: {
          seasonYear,
          status: "PAID",
        },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!nominator || nominator.subscriptions.length === 0) {
    throw new MembershipApplicationError(
      `${normalizedEmail} is not an active, paid-up ${CLUB_NAME} member`,
      422
    );
  }

  // Nomination eligibility gate: a member can only nominate once their own
  // induction is signed off and they meet the minimum tenure / nights stayed
  // (admin-configurable). Existing members who predate the gate are grandfathered.
  const eligibility = await checkNominatorEligibility({
    id: nominator.id,
    joinedDate: nominator.joinedDate,
    createdAt: nominator.createdAt,
  });

  if (!eligibility.eligible) {
    const reasonText = eligibility.reasons.join("; and ");
    throw new MembershipApplicationError(
      `${nominator.firstName} ${nominator.lastName} is not yet eligible to nominate a new member because ${reasonText}.`,
      422
    );
  }

  return {
    id: nominator.id,
    email: nominator.email,
    firstName: nominator.firstName,
    lastName: nominator.lastName,
  };
}

async function ensureApplicationCanBeCreated(
  applicantEmail: string,
  client: MembershipApplicationLookupClient = prisma
) {
  const normalizedEmail = cleanString(applicantEmail).toLowerCase();

  const [existingMember, existingApplication] = await Promise.all([
    client.member.findFirst({
      where: {
        email: normalizedEmail,
        canLogin: true,
      },
      select: { id: true },
    }),
    client.memberApplication.findFirst({
      where: {
        applicantEmail: normalizedEmail,
        status: {
          in: ["PENDING_NOMINATORS", "PENDING_ADMIN"],
        },
      },
      select: { id: true },
    }),
  ]);

  if (existingMember) {
    throw new MembershipApplicationError(
      `An active ${CLUB_NAME} account already exists for this email address`,
      409
    );
  }

  if (existingApplication) {
    throw new MembershipApplicationError(
      "There is already a membership application pending for this email address",
      409
    );
  }
}

function buildApplicationAddress(address: ApplicationAddress) {
  return parseApplicationAddress(address);
}

function buildResetToken() {
  return randomBytes(32).toString("hex");
}

function getApplicationDisplayName(
  application: Pick<MemberApplication, "applicantFirstName" | "applicantLastName">
) {
  return `${application.applicantFirstName} ${application.applicantLastName}`.trim();
}

function getNominatorSlot(
  application: Pick<MemberApplication, "nominator1Id" | "nominator2Id">,
  nominatorMemberId: string
): NominatorSlot | null {
  if (application.nominator1Id === nominatorMemberId) {
    return "nominator1";
  }

  if (application.nominator2Id === nominatorMemberId) {
    return "nominator2";
  }

  return null;
}

function isSlotConfirmed(
  application: Pick<MemberApplication, "nominator1ConfirmedAt" | "nominator2ConfirmedAt">,
  slot: NominatorSlot
) {
  return slot === "nominator1"
    ? Boolean(application.nominator1ConfirmedAt)
    : Boolean(application.nominator2ConfirmedAt);
}

function getSlotMemberId(
  application: Pick<MemberApplication, "nominator1Id" | "nominator2Id">,
  slot: NominatorSlot
) {
  return slot === "nominator1"
    ? application.nominator1Id
    : application.nominator2Id;
}

function getOtherSlotMemberId(
  application: Pick<MemberApplication, "nominator1Id" | "nominator2Id">,
  slot: NominatorSlot
) {
  return slot === "nominator1"
    ? application.nominator2Id
    : application.nominator1Id;
}

function getSlotEmailField(slot: NominatorSlot) {
  return slot === "nominator1" ? "nominator1Email" : "nominator2Email";
}

function getSlotIdField(slot: NominatorSlot) {
  return slot === "nominator1" ? "nominator1Id" : "nominator2Id";
}

function getSlotConfirmedAtField(slot: NominatorSlot) {
  return slot === "nominator1"
    ? "nominator1ConfirmedAt"
    : "nominator2ConfirmedAt";
}

async function sendNominationRequestForApplication({
  application,
  nominator,
  token,
  expiresAt,
}: {
  application: Pick<
    MemberApplication,
    "applicantFirstName" | "applicantLastName" | "familyMembers"
  >;
  nominator: Pick<VerifiedNominator, "email" | "firstName">;
  token: string;
  expiresAt: Date;
}) {
  await sendNominationRequestEmail({
    email: nominator.email,
    nominatorName: nominator.firstName,
    applicantName: getApplicationDisplayName(application),
    token,
    familyMemberCount: parseApplicationFamilyMembers(application.familyMembers).length,
    expiresAt,
  });
}

function membershipApplicationLockKey(applicationId: string) {
  return `member-application:${applicationId}`;
}

function membershipApplicationApplicantLockKey(applicantEmail: string) {
  return `member-application-applicant:${applicantEmail}`;
}

async function lockMembershipApplication(
  tx: MembershipApplicationLockClient,
  applicationId: string
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${membershipApplicationLockKey(applicationId)}))`;
}

async function lockMembershipApplicationApplicant(
  tx: MembershipApplicationLockClient,
  applicantEmail: string
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${membershipApplicationApplicantLockKey(applicantEmail)}))`;
}

export async function createMemberApplication(input: CreateMemberApplicationInput) {
  const applicantFirstName = cleanString(input.applicantFirstName);
  const applicantLastName = cleanString(input.applicantLastName);
  const applicantEmail = cleanString(input.applicantEmail).toLowerCase();
  const nominator1Email = cleanString(input.nominator1Email).toLowerCase();
  const nominator2Email = cleanString(input.nominator2Email).toLowerCase();
  const applicantDateOfBirth = cleanNullableString(input.applicantDateOfBirth);
  const applicantPhone = serializeApplicantPhone(input);
  const applicantAddress = buildApplicationAddress(input.address);
  const familyMembers = parseApplicationFamilyMembers(input.familyMembers);

  if (!applicantFirstName || !applicantLastName) {
    throw new MembershipApplicationError("Applicant name is required", 422);
  }

  if (!applicantDateOfBirth) {
    throw new MembershipApplicationError("Applicant date of birth is required", 422, {
      applicantDateOfBirth: ["Applicant date of birth is required"],
    });
  }

  if (nominator1Email === nominator2Email) {
    throw new MembershipApplicationError("Please provide two different nominators", 422, {
      nominator2Email: ["Please provide two different nominators"],
    });
  }

  if (applicantEmail === nominator1Email || applicantEmail === nominator2Email) {
    throw new MembershipApplicationError("Applicants cannot nominate themselves", 422);
  }

  await ensureApplicationCanBeCreated(applicantEmail);

  const [nominator1, nominator2] = await Promise.all([
    verifyNominator(nominator1Email),
    verifyNominator(nominator2Email),
  ]);

  const issuedAt = new Date();
  const token1 = issueActionToken();
  const token2 = issueActionToken();
  const expiresAt = getNominationTokenExpiryDate(issuedAt);

  const application = await prisma.$transaction(async (tx) => {
    await lockMembershipApplicationApplicant(tx, applicantEmail);
    await ensureApplicationCanBeCreated(applicantEmail, tx);

    const created = await tx.memberApplication.create({
      data: {
        applicantFirstName,
        applicantLastName,
        applicantEmail,
        applicantDateOfBirth: applicantDateOfBirth ? new Date(applicantDateOfBirth) : null,
        applicantPhone,
        applicantAddress,
        familyMembers,
        nominator1Email: nominator1.email,
        nominator2Email: nominator2.email,
        nominator1Id: nominator1.id,
        nominator2Id: nominator2.id,
      },
    });

    await tx.nominationToken.createMany({
      data: [
        {
          tokenHash: token1.tokenHash,
          applicationId: created.id,
          nominatorMemberId: nominator1.id,
          expiresAt,
          reminderCount: 0,
          lastSentAt: issuedAt,
        },
        {
          tokenHash: token2.tokenHash,
          applicationId: created.id,
          nominatorMemberId: nominator2.id,
          expiresAt,
          reminderCount: 0,
          lastSentAt: issuedAt,
        },
      ],
    });

    return created;
  });

  const emailWarnings: string[] = [];

  await Promise.all([
    sendNominationRequestForApplication({
      application,
      nominator: nominator1,
      token: token1.token,
      expiresAt,
    }).catch((err) => {
      logger.error({ err, applicationId: application.id, nominatorId: nominator1.id }, "Failed to send nomination email");
      emailWarnings.push(`Could not email ${nominator1.email}`);
    }),
    sendNominationRequestForApplication({
      application,
      nominator: nominator2,
      token: token2.token,
      expiresAt,
    }).catch((err) => {
      logger.error({ err, applicationId: application.id, nominatorId: nominator2.id }, "Failed to send nomination email");
      emailWarnings.push(`Could not email ${nominator2.email}`);
    }),
  ]);

  logAudit({
    action: "MEMBERSHIP_APPLICATION_CREATED",
    targetId: application.id,
    details: JSON.stringify({
      applicantEmail,
      nominator1Id: nominator1.id,
      nominator2Id: nominator2.id,
      familyMemberCount: familyMembers.length,
    }),
  });

  return {
    application,
    emailWarnings,
  };
}

export async function confirmNomination(token: string, nominatorMemberId: string) {
  const normalizedToken = cleanString(token);
  if (!normalizedToken) {
    throw new MembershipApplicationError("Nomination token is required", 422);
  }
  const tokenHash = hashActionToken(normalizedToken);

  const current = await prisma.nominationToken.findUnique({
    where: { tokenHash },
    include: { application: true },
  });

  if (!current) {
    throw new MembershipApplicationError("This nomination link is invalid", 404);
  }

  if (current.nominatorMemberId !== nominatorMemberId) {
    throw new MembershipApplicationError("This nomination link is for a different member", 403);
  }

  if (current.expiresAt < new Date()) {
    throw new MembershipApplicationError("This nomination link has expired", 410);
  }

  if (current.application.status === ApplicationStatus.REJECTED) {
    throw new MembershipApplicationError("This application has already been rejected", 409);
  }

  if (current.application.status === ApplicationStatus.APPROVED) {
    return { application: current.application, movedToAdmin: false, alreadyConfirmed: true };
  }

  const currentSlot = getNominatorSlot(current.application, current.nominatorMemberId);
  if (!currentSlot) {
    throw new MembershipApplicationError("This nomination link has been replaced", 409);
  }

  if (isSlotConfirmed(current.application, currentSlot)) {
    return { application: current.application, movedToAdmin: false, alreadyConfirmed: true };
  }

  if (current.confirmedAt) {
    return { application: current.application, movedToAdmin: false, alreadyConfirmed: true };
  }

  const confirmedAt = new Date();

  const result = await prisma.$transaction(async (tx) => {
    await lockMembershipApplication(tx, current.applicationId);

    const latestToken = await tx.nominationToken.findUnique({
      where: { tokenHash },
      include: { application: true },
    });

    if (!latestToken) {
      throw new MembershipApplicationError("This nomination link is invalid", 404);
    }

    if (latestToken.nominatorMemberId !== nominatorMemberId) {
      throw new MembershipApplicationError("This nomination link is for a different member", 403);
    }

    if (latestToken.expiresAt < new Date()) {
      throw new MembershipApplicationError("This nomination link has expired", 410);
    }

    if (latestToken.application.status === ApplicationStatus.REJECTED) {
      throw new MembershipApplicationError("This application has already been rejected", 409);
    }

    if (latestToken.application.status === ApplicationStatus.APPROVED) {
      return {
        application: latestToken.application,
        movedToAdmin: false,
        alreadyConfirmed: true,
      };
    }

    const latestSlot = getNominatorSlot(
      latestToken.application,
      latestToken.nominatorMemberId
    );
    if (!latestSlot) {
      throw new MembershipApplicationError(
        "This nomination link has been replaced",
        409
      );
    }

    if (isSlotConfirmed(latestToken.application, latestSlot)) {
      return {
        application: latestToken.application,
        movedToAdmin: false,
        alreadyConfirmed: true,
      };
    }

    if (latestToken.confirmedAt) {
      return {
        application: latestToken.application,
        movedToAdmin: false,
        alreadyConfirmed: true,
      };
    }

    await tx.nominationToken.update({
      where: { id: latestToken.id },
      data: { confirmedAt },
    });

    const isFirstNominator = latestSlot === "nominator1";
    const nextNominator1ConfirmedAt = isFirstNominator
      ? confirmedAt
      : latestToken.application.nominator1ConfirmedAt;
    const nextNominator2ConfirmedAt = isFirstNominator
      ? latestToken.application.nominator2ConfirmedAt
      : confirmedAt;
    const movedToAdmin =
      latestToken.application.status === ApplicationStatus.PENDING_NOMINATORS &&
      Boolean(nextNominator1ConfirmedAt && nextNominator2ConfirmedAt);

    const application = await tx.memberApplication.update({
      where: { id: latestToken.applicationId },
      data: {
        nominator1ConfirmedAt: nextNominator1ConfirmedAt,
        nominator2ConfirmedAt: nextNominator2ConfirmedAt,
        ...(movedToAdmin ? { status: ApplicationStatus.PENDING_ADMIN } : {}),
      },
    });

    return {
      application,
      movedToAdmin,
      alreadyConfirmed: false,
    };
  });

  logAudit({
    action: "MEMBERSHIP_APPLICATION_NOMINATION_CONFIRMED",
    memberId: nominatorMemberId,
    targetId: result.application.id,
    details: JSON.stringify({ movedToAdmin: result.movedToAdmin }),
  });

  if (result.movedToAdmin) {
    sendAdminMembershipApplicationPendingEmail({
      applicationId: result.application.id,
      applicantName: getApplicationDisplayName(result.application),
      applicantEmail: result.application.applicantEmail,
      familyMemberCount: parseApplicationFamilyMembers(result.application.familyMembers).length,
    }).catch((err) => {
      logger.error({ err, applicationId: result.application.id }, "Failed to send admin membership application alert");
    });
  }

  return result;
}

export interface NominationReminderRunResult {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function sendDueNominationReminders({
  now = new Date(),
  limit = 100,
}: {
  now?: Date;
  limit?: number;
} = {}): Promise<NominationReminderRunResult> {
  const take = Math.min(Math.max(limit, 1), 200);
  const candidates = await prisma.nominationToken.findMany({
    where: {
      confirmedAt: null,
      expiresAt: { lte: now },
      reminderCount: { lt: NOMINATION_AUTOMATIC_REMINDER_LIMIT },
      application: { status: ApplicationStatus.PENDING_NOMINATORS },
    },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
    take,
    include: { application: true },
  });

  const nominatorIds = Array.from(
    new Set(candidates.map((candidate) => candidate.nominatorMemberId))
  );
  const nominators = nominatorIds.length
    ? await prisma.member.findMany({
        where: {
          id: { in: nominatorIds },
          active: true,
        },
        select: { id: true, email: true, firstName: true, lastName: true },
      })
    : [];
  const nominatorById = new Map(nominators.map((nominator) => [nominator.id, nominator]));

  const result: NominationReminderRunResult = {
    scanned: candidates.length,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    const slot = getNominatorSlot(candidate.application, candidate.nominatorMemberId);
    const nominator = nominatorById.get(candidate.nominatorMemberId);

    if (!slot || isSlotConfirmed(candidate.application, slot) || !nominator) {
      result.skipped += 1;
      continue;
    }

    const issued = issueActionToken();
    const expiresAt = getNominationTokenExpiryDate(now);
    const update = await prisma.nominationToken.updateMany({
      where: {
        id: candidate.id,
        confirmedAt: null,
        expiresAt: candidate.expiresAt,
        reminderCount: candidate.reminderCount,
        application: { status: ApplicationStatus.PENDING_NOMINATORS },
      },
      data: {
        tokenHash: issued.tokenHash,
        expiresAt,
        reminderCount: { increment: 1 },
        lastSentAt: now,
      },
    });

    if (update.count !== 1) {
      result.skipped += 1;
      continue;
    }

    try {
      await sendNominationRequestForApplication({
        application: candidate.application,
        nominator,
        token: issued.token,
        expiresAt,
      });
      result.sent += 1;
      await logAudit({
        action: "membership_application.nomination_reminder_sent",
        memberId: candidate.nominatorMemberId,
        subjectMemberId: candidate.nominatorMemberId,
        targetId: candidate.applicationId,
        entityType: "NominationToken",
        entityId: candidate.id,
        category: "communication",
        severity: "info",
        outcome: "success",
        summary: "Membership nomination reminder sent",
        metadata: {
          applicationId: candidate.applicationId,
          nominatorMemberId: candidate.nominatorMemberId,
          reminderCount: candidate.reminderCount + 1,
          reminderLimit: NOMINATION_AUTOMATIC_REMINDER_LIMIT,
        },
      });
    } catch (err) {
      result.failed += 1;
      logger.error(
        {
          err,
          applicationId: candidate.applicationId,
          nominatorId: candidate.nominatorMemberId,
        },
        "Failed to send membership nomination reminder"
      );
    }
  }

  return result;
}

function getPendingNominatorSlots(application: MemberApplication): NominatorSlot[] {
  return (["nominator1", "nominator2"] as const).filter(
    (slot) => !isSlotConfirmed(application, slot)
  );
}

export async function refreshMemberApplicationNominations(
  applicationId: string,
  adminMemberId: string
) {
  const issuedAt = new Date();
  const prepared = await prisma.$transaction(async (tx) => {
    await lockMembershipApplication(tx, applicationId);

    const application = await tx.memberApplication.findUnique({
      where: { id: applicationId },
    });

    if (!application) {
      throw new MembershipApplicationError("Application not found", 404);
    }

    if (application.status !== ApplicationStatus.PENDING_NOMINATORS) {
      throw new MembershipApplicationError(
        "Only applications waiting on nominators can be refreshed",
        409
      );
    }

    const pendingSlots = getPendingNominatorSlots(application);
    if (pendingSlots.length === 0) {
      throw new MembershipApplicationError(
        "This application has no pending nominators to refresh",
        409
      );
    }

    const nominatorIds = pendingSlots
      .map((slot) => getSlotMemberId(application, slot))
      .filter((value): value is string => Boolean(value));
    const nominators = await tx.member.findMany({
      where: { id: { in: nominatorIds }, active: true },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    const nominatorById = new Map(nominators.map((nominator) => [nominator.id, nominator]));
    const emails: Array<{
      slot: NominatorSlot;
      nominator: VerifiedNominator;
      token: string;
      expiresAt: Date;
      tokenId: string;
    }> = [];

    for (const slot of pendingSlots) {
      const nominatorMemberId = getSlotMemberId(application, slot);
      if (!nominatorMemberId) {
        throw new MembershipApplicationError(
          "This application is missing a pending nominator member",
          409
        );
      }

      const nominator = nominatorById.get(nominatorMemberId);
      if (!nominator) {
        throw new MembershipApplicationError(
          "A pending nominator is no longer active",
          409
        );
      }

      const issued = issueActionToken();
      const expiresAt = getNominationTokenExpiryDate(issuedAt);

      await tx.nominationToken.deleteMany({
        where: {
          applicationId,
          nominatorMemberId,
          confirmedAt: null,
        },
      });
      const createdToken = await tx.nominationToken.create({
        data: {
          tokenHash: issued.tokenHash,
          applicationId,
          nominatorMemberId,
          expiresAt,
          reminderCount: 0,
          lastSentAt: issuedAt,
        },
        select: { id: true },
      });

      emails.push({
        slot,
        nominator,
        token: issued.token,
        expiresAt,
        tokenId: createdToken.id,
      });
    }

    return { application, emails };
  });

  const emailWarnings: string[] = [];
  await Promise.all(
    prepared.emails.map((email) =>
      sendNominationRequestForApplication({
        application: prepared.application,
        nominator: email.nominator,
        token: email.token,
        expiresAt: email.expiresAt,
      }).catch((err) => {
        logger.error(
          {
            err,
            applicationId,
            nominatorId: email.nominator.id,
          },
          "Failed to send refreshed nomination request"
        );
        emailWarnings.push(`Could not email ${email.nominator.email}`);
      })
    )
  );

  await logAudit({
    action: "membership_application.nomination_workflow_refreshed",
    memberId: adminMemberId,
    actorMemberId: adminMemberId,
    targetId: applicationId,
    entityType: "MemberApplication",
    entityId: applicationId,
    category: "membership",
    severity: "important",
    outcome: "success",
    summary: "Membership nomination workflow refreshed",
    metadata: {
      applicationId,
      refreshedSlots: prepared.emails.map((email) => email.slot),
      tokenIds: prepared.emails.map((email) => email.tokenId),
      emailWarnings,
    },
  });

  return {
    application: prepared.application,
    refreshedCount: prepared.emails.length,
    emailWarnings,
  };
}

export async function replaceMemberApplicationNominator({
  applicationId,
  slot,
  replacementMemberId,
  adminMemberId,
}: {
  applicationId: string;
  slot: NominatorSlot;
  replacementMemberId: string;
  adminMemberId: string;
}) {
  const replacement = await prisma.member.findFirst({
    where: { id: replacementMemberId },
    select: { id: true, email: true },
  });

  if (!replacement) {
    throw new MembershipApplicationError("Replacement nominator not found", 404);
  }

  const verifiedReplacement = await verifyNominator(replacement.email);
  if (verifiedReplacement.id !== replacementMemberId) {
    throw new MembershipApplicationError(
      "Replacement nominator must be the selected active member",
      409
    );
  }

  const issuedAt = new Date();
  const issued = issueActionToken();
  const expiresAt = getNominationTokenExpiryDate(issuedAt);

  const updated = await prisma.$transaction(async (tx) => {
    await lockMembershipApplication(tx, applicationId);

    const application = await tx.memberApplication.findUnique({
      where: { id: applicationId },
    });

    if (!application) {
      throw new MembershipApplicationError("Application not found", 404);
    }

    if (application.status !== ApplicationStatus.PENDING_NOMINATORS) {
      throw new MembershipApplicationError(
        "Only applications waiting on nominators can have nominators replaced",
        409
      );
    }

    if (isSlotConfirmed(application, slot)) {
      throw new MembershipApplicationError(
        "Confirmed nominators cannot be replaced",
        409
      );
    }

    if (getOtherSlotMemberId(application, slot) === verifiedReplacement.id) {
      throw new MembershipApplicationError(
        "Please choose a different member from the other nominator",
        422
      );
    }

    if (
      cleanString(application.applicantEmail).toLowerCase() ===
      cleanString(verifiedReplacement.email).toLowerCase()
    ) {
      throw new MembershipApplicationError("Applicants cannot nominate themselves", 422);
    }

    const previousNominatorId = getSlotMemberId(application, slot);
    if (previousNominatorId) {
      await tx.nominationToken.deleteMany({
        where: {
          applicationId,
          nominatorMemberId: previousNominatorId,
          confirmedAt: null,
        },
      });
    }

    const createdToken = await tx.nominationToken.create({
      data: {
        tokenHash: issued.tokenHash,
        applicationId,
        nominatorMemberId: verifiedReplacement.id,
        expiresAt,
        reminderCount: 0,
        lastSentAt: issuedAt,
      },
      select: { id: true },
    });

    const updatedApplication = await tx.memberApplication.update({
      where: { id: applicationId },
      data: {
        [getSlotIdField(slot)]: verifiedReplacement.id,
        [getSlotEmailField(slot)]: verifiedReplacement.email,
        [getSlotConfirmedAtField(slot)]: null,
      },
    });

    return {
      application: updatedApplication,
      previousNominatorId,
      tokenId: createdToken.id,
    };
  });

  const emailWarnings: string[] = [];
  try {
    await sendNominationRequestForApplication({
      application: updated.application,
      nominator: verifiedReplacement,
      token: issued.token,
      expiresAt,
    });
  } catch (err) {
    logger.error(
      { err, applicationId, nominatorId: verifiedReplacement.id },
      "Failed to send replacement nomination request"
    );
    emailWarnings.push(`Could not email ${verifiedReplacement.email}`);
  }

  await logAudit({
    action: "membership_application.nominator_replaced",
    memberId: adminMemberId,
    actorMemberId: adminMemberId,
    subjectMemberId: verifiedReplacement.id,
    targetId: applicationId,
    entityType: "MemberApplication",
    entityId: applicationId,
    category: "membership",
    severity: "important",
    outcome: "success",
    summary: "Membership application nominator replaced",
    metadata: {
      applicationId,
      slot,
      previousNominatorId: updated.previousNominatorId,
      replacementNominatorId: verifiedReplacement.id,
      tokenId: updated.tokenId,
      emailWarnings,
    },
  });

  return {
    application: updated.application,
    replacementNominatorId: verifiedReplacement.id,
    emailWarnings,
  };
}

async function syncApprovedMembersToXero(memberIds: string[]) {
  const warnings: string[] = [];

  let connected = false;
  try {
    connected = await isXeroConnected();
  } catch {
    connected = false;
  }

  if (!connected) {
    return warnings;
  }

  for (const memberId of memberIds) {
    try {
      await findOrCreateXeroContact(memberId);
    } catch (err) {
      logger.error({ err, memberId }, "Failed to sync approved member to Xero");
      warnings.push(`Xero contact sync failed for member ${memberId.slice(0, 8)}`);
    }
  }

  return warnings;
}

export async function approveMemberApplication(
  applicationId: string,
  adminMemberId: string,
  adminNotes?: string | null,
  entranceFeeInvoiceDecision?: EntranceFeeInvoiceApprovalDecision | null,
  // #1786: admin per-action email choice. Absent/undefined = notify (default);
  // false = suppress the applicant-facing approval notice. Gates only that
  // applicant email — the induction sign-off requests below are token-bearing
  // requests to the assigned signers and always send.
  notifyMember?: boolean
) {
  const application = await prisma.memberApplication.findUnique({
    where: { id: applicationId },
  });

  if (!application) {
    throw new MembershipApplicationError("Application not found", 404);
  }

  if (application.status !== ApplicationStatus.PENDING_ADMIN) {
    throw new MembershipApplicationError("Only applications pending admin review can be approved", 409);
  }

  if (!application.applicantDateOfBirth) {
    throw new MembershipApplicationError(
      "Applicant date of birth is required before approval",
      409
    );
  }

  const applicantPasswordHash = await hash(randomBytes(32).toString("hex"), 13);
  const passwordSetupToken = buildResetToken();
  const passwordSetupExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const approved = await prisma.$transaction(async (tx) => {
    await lockMembershipApplication(tx, applicationId);

    const lockedApplication = await tx.memberApplication.findUnique({
      where: { id: applicationId },
    });

    if (!lockedApplication) {
      throw new MembershipApplicationError("Application not found", 404);
    }

    if (lockedApplication.status !== ApplicationStatus.PENDING_ADMIN) {
      throw new MembershipApplicationError(
        "Only applications pending admin review can be approved",
        409
      );
    }

    if (!lockedApplication.applicantDateOfBirth) {
      throw new MembershipApplicationError(
        "Applicant date of birth is required before approval",
        409
      );
    }

    const address = parseApplicationAddress(lockedApplication.applicantAddress);
    const familyMembers = parseApplicationFamilyMembers(lockedApplication.familyMembers);
    const applicantPhone = parseApplicantPhone(lockedApplication.applicantPhone);
    const applicantAgeTier = await computeTier(
      lockedApplication.applicantDateOfBirth.toISOString().slice(0, 10)
    );
    // The application form captures the booking-gate profile details, so
    // approval counts as initial confirmation for the applicant and dependents.
    const profileConfirmedAt = new Date();

    const existing = await tx.member.findFirst({
      where: {
        email: lockedApplication.applicantEmail,
        canLogin: true,
      },
      select: { id: true },
    });

    if (existing) {
      throw new MembershipApplicationError(
        `A ${CLUB_NAME} login already exists for this applicant email address`,
        409
      );
    }

    const applicantMember = await tx.member.create({
      data: {
        email: lockedApplication.applicantEmail,
        passwordHash: applicantPasswordHash,
        emailVerified: true,
        firstName: lockedApplication.applicantFirstName,
        lastName: lockedApplication.applicantLastName,
        dateOfBirth: lockedApplication.applicantDateOfBirth,
        role: "USER",
        ageTier: applicantAgeTier,
        active: true,
        canLogin: true,
        phoneCountryCode: applicantPhone.phoneCountryCode,
        phoneAreaCode: applicantPhone.phoneAreaCode,
        phoneNumber: applicantPhone.phoneNumber,
        streetAddressLine1: address.streetAddressLine1,
        streetAddressLine2: address.streetAddressLine2,
        streetCity: address.streetCity,
        streetRegion: address.streetRegion,
        streetPostalCode: address.streetPostalCode,
        streetCountry: address.streetCountry,
        postalAddressLine1: address.postalAddressLine1,
        postalAddressLine2: address.postalAddressLine2,
        postalCity: address.postalCity,
        postalRegion: address.postalRegion,
        postalPostalCode: address.postalPostalCode,
        postalCountry: address.postalCountry,
        profileCompletedAt: profileConfirmedAt,
        detailsConfirmedAt: profileConfirmedAt,
        onboardingConfirmedAt: profileConfirmedAt,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
      },
    });

    await tx.member.update({
      where: { id: applicantMember.id },
      data: {
        detailsConfirmedByMemberId: applicantMember.id,
      },
    });

    let familyGroupId: string | null = null;
    if (familyMembers.length > 0) {
      const familyGroup = await tx.familyGroup.create({
        data: {
          name: `${lockedApplication.applicantLastName} Family`,
        },
        select: { id: true },
      });
      familyGroupId = familyGroup.id;

      await tx.familyGroupMember.create({
        data: {
          familyGroupId,
          memberId: applicantMember.id,
          role: "ADMIN",
        },
      });
    }

    const dependentMemberIds: string[] = [];
    for (const familyMember of familyMembers) {
      const dependentAgeTier = await computeTier(familyMember.dateOfBirth);
      const dependent = await tx.member.create({
        data: {
          email: lockedApplication.applicantEmail,
          passwordHash: applicantPasswordHash,
          emailVerified: true,
          firstName: familyMember.firstName,
          lastName: familyMember.lastName,
          dateOfBirth: new Date(familyMember.dateOfBirth),
          role: "USER",
          ageTier: dependentAgeTier,
          active: true,
          canLogin: false,
          parentMemberId: applicantMember.id,
          inheritParentEmail: true,
          inheritEmailFromId: applicantMember.id,
          phoneCountryCode: applicantPhone.phoneCountryCode,
          phoneAreaCode: applicantPhone.phoneAreaCode,
          phoneNumber: applicantPhone.phoneNumber,
          streetAddressLine1: address.streetAddressLine1,
          streetAddressLine2: address.streetAddressLine2,
          streetCity: address.streetCity,
          streetRegion: address.streetRegion,
          streetPostalCode: address.streetPostalCode,
          streetCountry: address.streetCountry,
          postalAddressLine1: address.postalAddressLine1,
          postalAddressLine2: address.postalAddressLine2,
          postalCity: address.postalCity,
          postalRegion: address.postalRegion,
          postalPostalCode: address.postalPostalCode,
          postalCountry: address.postalCountry,
          profileCompletedAt: profileConfirmedAt,
          detailsConfirmedAt: profileConfirmedAt,
          detailsConfirmedByMemberId: applicantMember.id,
          onboardingConfirmedAt: profileConfirmedAt,
        },
        select: { id: true },
      });
      dependentMemberIds.push(dependent.id);

      if (familyGroupId) {
        await tx.familyGroupMember.create({
          data: {
            familyGroupId,
            memberId: dependent.id,
            role: "MEMBER",
          },
        });
      }
    }

    await tx.passwordResetToken.deleteMany({
      where: { memberId: applicantMember.id },
    });

    await tx.passwordResetToken.create({
      data: {
        tokenHash: hashActionToken(passwordSetupToken),
        memberId: applicantMember.id,
        expiresAt: passwordSetupExpiresAt,
      },
    });

    const updatedApplication = await tx.memberApplication.update({
      where: { id: lockedApplication.id },
      data: {
        status: ApplicationStatus.APPROVED,
        adminNotes: cleanNullableString(adminNotes),
        reviewedBy: adminMemberId,
        reviewedAt: new Date(),
      },
    });

    return {
      application: updatedApplication,
      applicantMember,
      createdMemberIds: [applicantMember.id, ...dependentMemberIds],
    };
  });

  const warnings = await syncApprovedMembersToXero(approved.createdMemberIds);

  // Subscription billing is deliberately post-approval and non-blocking.
  // Complete configuration creates immutable charges and durable Xero work;
  // incomplete configuration creates visible billing exceptions instead of
  // rolling back membership approval.
  try {
    const subscriptionBilling = await queueApprovedMembershipSubscriptionCharges({
      memberIds: approved.createdMemberIds,
      approvedByMemberId: adminMemberId,
    });
    if (subscriptionBilling.exceptionCount > 0) {
      warnings.push(
        `${subscriptionBilling.exceptionCount} membership subscription billing exception${subscriptionBilling.exceptionCount === 1 ? " requires" : "s require"} Finance review`,
      );
    }
  } catch (err) {
    logger.error(
      { err, applicationId, memberIds: approved.createdMemberIds },
      "Failed to queue membership subscription billing after approval",
    );
    warnings.push("Membership subscription billing could not be queued automatically");
  }

  const entranceFeeDecision = entranceFeeInvoiceDecision ?? { action: "CREATE" as const };
  if (entranceFeeDecision.action === "CREATE") {
    try {
      const entranceFeeInvoiceOptions: {
        createdByMemberId: string;
        amountCents?: number;
        description?: string;
      } = {
        createdByMemberId: adminMemberId,
      };
      if (entranceFeeDecision.amountCents) {
        entranceFeeInvoiceOptions.amountCents = entranceFeeDecision.amountCents;
      }
      const narration = entranceFeeDecision.narration?.trim();
      if (narration) {
        entranceFeeInvoiceOptions.description = narration;
      }

      const queuedEntranceFeeInvoice = await enqueueXeroEntranceFeeInvoiceOperation(
        approved.applicantMember.id,
        entranceFeeInvoiceOptions
      );

      if (queuedEntranceFeeInvoice.queueOperationId && (await isXeroConnected())) {
        void processQueuedXeroOutboxOperations({ limit: 1 }).catch((err) => {
          logger.error(
            { err, memberId: approved.applicantMember.id },
            "Failed to kick Xero entrance fee outbox worker for approved application"
          );
        });
      }
    } catch (err) {
      logger.error(
        { err, memberId: approved.applicantMember.id },
        "Failed to queue entrance fee invoice for approved application"
      );
      warnings.push("Entrance fee invoice could not be queued automatically");
    }
  } else {
    await logAudit({
      action: "XERO_ENTRANCE_FEE_INVOICE_SKIPPED",
      memberId: adminMemberId,
      targetId: approved.applicantMember.id,
      subjectMemberId: approved.applicantMember.id,
      entityType: "Member",
      entityId: approved.applicantMember.id,
      category: "xero",
      outcome: "success",
      summary: "Entrance fee invoice skipped for approved application",
      details: entranceFeeDecision.reason,
      metadata: {
        applicationId,
        reason: entranceFeeDecision.reason,
        source: "member-application-approval",
      },
    });
  }

  // #1786: the applicant approval notice carries the password-setup link and is
  // gated by the admin's per-action notify choice (default is notify). The
  // induction sign-off requests below are token-bearing requests to the assigned
  // signers and stay always-send, regardless of this choice.
  if (notifyMember !== false) {
    try {
      await sendMembershipApplicationApprovedEmail({
        email: approved.applicantMember.email,
        firstName: approved.applicantMember.firstName,
        token: passwordSetupToken,
        adminNotes: cleanNullableString(adminNotes),
      });
    } catch (err) {
      logger.error({ err, applicationId }, "Failed to send approved membership email");
      warnings.push("The approval email could not be sent automatically");
    }
  }

  // Create the new member's lodge induction record and ask their nominators to
  // sign it off, when the Lodge induction module is enabled. Non-fatal:
  // failures become warnings, like the Xero sync above.
  const inductionModules = await loadEffectiveModuleFlags();
  if (inductionModules.induction) {
    try {
      const nominatorIds = Array.from(new Set([
        approved.application.nominator1Id,
        approved.application.nominator2Id,
      ].filter((value): value is string => Boolean(value))));

      const induction = await createMemberInduction({
        memberId: approved.applicantMember.id,
        kind: "NEW_MEMBER",
        applicationId,
        createdByMemberId: adminMemberId,
        signerMemberIds: nominatorIds,
      });

      if (nominatorIds.length > 0) {
        const nominators = await prisma.member.findMany({
          where: { id: { in: nominatorIds } },
          select: { id: true, email: true, firstName: true },
        });
        const inducteeName =
          `${approved.applicantMember.firstName} ${approved.applicantMember.lastName}`.trim();

        await Promise.all(
          nominators.map(async (nominator) => {
            try {
              await sendInductionSignOffRequestEmail({
                email: nominator.email,
                signerName: nominator.firstName,
                inducteeName,
                signerRoleLabel: "Nominator",
              });
              await prisma.memberInductionAssignedSigner.updateMany({
                where: { inductionId: induction.id, memberId: nominator.id },
                data: { emailSentAt: new Date() },
              });
            } catch (err) {
              logger.error(
                { err, applicationId, nominatorId: nominator.id },
                "Failed to send induction sign-off request email"
              );
              warnings.push(
                `Could not email induction sign-off request to ${nominator.email}`
              );
            }
          })
        );
      }
    } catch (err) {
      logger.error(
        { err, applicationId },
        "Failed to create induction for approved application"
      );
      warnings.push("The induction record could not be created automatically");
    }
  }

  if (warnings.length > 0) {
    await prisma.memberApplication
      .update({
        where: { id: applicationId },
        data: {
          adminNotes: appendPostApprovalWarnings(
            approved.application.adminNotes ?? adminNotes,
            warnings
          ),
        },
      })
      .catch((err) => {
        logger.error(
          { err, applicationId, warnings },
          "Failed to persist membership approval follow-up warnings"
        );
      });
  }

  // #1786: honesty rule — only record the notify choice when the applicant
  // approval email was actually suppressed. The send is otherwise unconditional
  // (the applicant email is a required application field), so no would-have-sent
  // guard is needed. A notify/default choice records no notifyMember field.
  const notifyAuditFields = notifyMember === false ? { notifyMember: false } : {};

  logAudit({
    action: "MEMBERSHIP_APPLICATION_APPROVED",
    memberId: adminMemberId,
    targetId: applicationId,
    details: JSON.stringify({
      applicantMemberId: approved.applicantMember.id,
      createdMemberCount: approved.createdMemberIds.length,
      postApprovalWarnings: warnings,
      ...notifyAuditFields,
    }),
  });

  return {
    ...approved,
    warnings,
  };
}

// Applications an admin may reject: those still gathering nominations and those
// pending admin review. APPROVED/REJECTED are terminal and cannot be rejected.
const REJECTABLE_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.PENDING_NOMINATORS,
  ApplicationStatus.PENDING_ADMIN,
];

function isRejectableApplicationStatus(status: ApplicationStatus): boolean {
  return REJECTABLE_APPLICATION_STATUSES.includes(status);
}

export async function rejectMemberApplication(
  applicationId: string,
  adminMemberId: string,
  adminNotes?: string | null,
  // #1786: admin per-action email choice. Absent/undefined = notify (default);
  // false = suppress the applicant-facing rejection notice.
  notifyMember?: boolean
) {
  const application = await prisma.memberApplication.findUnique({
    where: { id: applicationId },
  });

  if (!application) {
    throw new MembershipApplicationError("Application not found", 404);
  }

  // Admins can reject an application that is still gathering nominations as well
  // as one pending admin review. A PENDING_NOMINATORS application whose
  // nomination tokens have expired would otherwise be stuck forever, and it
  // keeps blocking a fresh application for the same email (the duplicate-
  // application check blocks on PENDING_NOMINATORS/PENDING_ADMIN). Rejecting it
  // sets REJECTED, which is excluded from that block, so a new application can
  // be submitted. confirmNomination already returns a clean 409 if a nominator
  // opens a token after the application was rejected (issue #817).
  if (!isRejectableApplicationStatus(application.status)) {
    throw new MembershipApplicationError(
      "Only pending applications can be rejected",
      409
    );
  }

  const rejected = await prisma.$transaction(async (tx) => {
    await lockMembershipApplication(tx, applicationId);

    const lockedApplication = await tx.memberApplication.findUnique({
      where: { id: applicationId },
    });

    if (!lockedApplication) {
      throw new MembershipApplicationError("Application not found", 404);
    }

    if (!isRejectableApplicationStatus(lockedApplication.status)) {
      throw new MembershipApplicationError(
        "Only pending applications can be rejected",
        409
      );
    }

    return tx.memberApplication.update({
      where: { id: applicationId },
      data: {
        status: ApplicationStatus.REJECTED,
        adminNotes: cleanNullableString(adminNotes),
        reviewedBy: adminMemberId,
        reviewedAt: new Date(),
      },
    });
  });

  // #1786: applicant rejection notice — gated by the admin's per-action notify
  // choice (default is notify).
  if (notifyMember !== false) {
    try {
      await sendMembershipApplicationRejectedEmail({
        email: rejected.applicantEmail,
        firstName: rejected.applicantFirstName,
        adminNotes: cleanNullableString(adminNotes),
      });
    } catch (err) {
      logger.error({ err, applicationId }, "Failed to send rejected membership email");
    }
  }

  // #1786: honesty rule — record the notify choice only when the applicant
  // rejection email was actually suppressed (the send is otherwise
  // unconditional). A notify/default choice records no notifyMember field.
  const notifyAuditFields = notifyMember === false ? { notifyMember: false } : {};

  logAudit({
    action: "MEMBERSHIP_APPLICATION_REJECTED",
    memberId: adminMemberId,
    targetId: applicationId,
    details: JSON.stringify({
      applicantEmail: rejected.applicantEmail,
      ...notifyAuditFields,
    }),
  });

  return rejected;
}
