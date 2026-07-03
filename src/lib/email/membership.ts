import {
  inductionSignOffRequestTemplate,
  nominationRequestTemplate,
  membershipApplicationApprovedTemplate,
  membershipApplicationRejectedTemplate,
  ageUpInvitationTemplate,
  ageUpParentEmailHandoffTemplate,
  membershipCancellationSubmittedTemplate,
  membershipCancellationConfirmationTemplate,
  membershipCancellationApprovedTemplate,
  membershipCancellationRejectedTemplate,
  memberArchiveApprovedTemplate,
  memberArchiveRejectedTemplate,
} from "../email-templates";
import {
  CLUB_BOOKINGS_NAME,
  CLUB_NAME,
} from "@/config/club-identity";
import { formatNZDateTime } from "../nzst-date";
import { sendEmail } from "./core";

export async function sendNominationRequestEmail(params: {
  email: string;
  nominatorName: string;
  applicantName: string;
  token: string;
  familyMemberCount: number;
  expiresAt: Date;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/nominations/${params.token}`;

  await sendEmail({
    to: params.email,
    subject: `Nomination request for ${params.applicantName} — ${CLUB_NAME}`,
    html: nominationRequestTemplate({
      nominatorName: params.nominatorName,
      applicantName: params.applicantName,
      reviewUrl,
      familyMemberCount: params.familyMemberCount,
      expiresAt: params.expiresAt,
    }),
    templateName: "nomination-request",
    templateData: {
      nominatorName: params.nominatorName,
      applicantName: params.applicantName,
      token: params.token,
      reviewUrl,
      familyMemberCount: params.familyMemberCount,
      expiresAt: formatNZDateTime(params.expiresAt),
    },
  });
}

export async function sendInductionSignOffRequestEmail(params: {
  email: string;
  signerName: string;
  inducteeName: string;
  signerRoleLabel: string;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const inductionUrl = `${baseUrl}/induction`;

  await sendEmail({
    to: params.email,
    subject: `Lodge induction sign-off for ${params.inducteeName} — ${CLUB_NAME}`,
    html: inductionSignOffRequestTemplate({
      signerName: params.signerName,
      inducteeName: params.inducteeName,
      signerRoleLabel: params.signerRoleLabel,
      inductionUrl,
    }),
    templateName: "induction-sign-off-request",
    templateData: {
      signerName: params.signerName,
      inducteeName: params.inducteeName,
      signerRoleLabel: params.signerRoleLabel,
      inductionUrl,
    },
  });
}

export async function sendMembershipApplicationApprovedEmail(params: {
  email: string;
  firstName: string;
  token: string;
  adminNotes?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${params.token}`;

  await sendEmail({
    to: params.email,
    subject: `Your ${CLUB_NAME} membership has been approved`,
    html: membershipApplicationApprovedTemplate(
      params.firstName,
      resetUrl,
      params.adminNotes,
    ),
    templateName: "membership-application-approved",
    templateData: {
      firstName: params.firstName,
      token: params.token,
      resetUrl,
      adminNotes: params.adminNotes ?? "",
    },
  });
}

export async function sendMembershipApplicationRejectedEmail(params: {
  email: string;
  firstName: string;
  adminNotes?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Update on your ${CLUB_NAME} membership application`,
    html: membershipApplicationRejectedTemplate(
      params.firstName,
      params.adminNotes,
    ),
    templateName: "membership-application-rejected",
    templateData: {
      firstName: params.firstName,
      adminNotes: params.adminNotes ?? "",
    },
  });
}

export async function sendMembershipCancellationSubmittedEmail(params: {
  email: string;
  firstName: string;
  participantSummary: string;
  reason?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/profile`;

  await sendEmail({
    to: params.email,
    subject: `Membership cancellation request submitted — ${CLUB_BOOKINGS_NAME}`,
    html: membershipCancellationSubmittedTemplate({
      firstName: params.firstName,
      participantSummary: params.participantSummary,
      reason: params.reason,
      reviewUrl,
    }),
    templateName: "membership-cancellation-submitted",
    templateData: {
      firstName: params.firstName,
      participantSummary: params.participantSummary,
      reason: params.reason ?? "",
      reviewUrl,
    },
  });
}

export async function sendMembershipCancellationConfirmationEmail(params: {
  email: string;
  firstName: string;
  requesterName: string;
  participantName: string;
  token: string;
  expiresAt: Date;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const confirmationUrl = `${baseUrl}/membership-cancellation/${params.token}`;

  await sendEmail({
    to: params.email,
    subject: `Confirm membership cancellation request — ${CLUB_BOOKINGS_NAME}`,
    html: membershipCancellationConfirmationTemplate({
      firstName: params.firstName,
      requesterName: params.requesterName,
      participantName: params.participantName,
      confirmationUrl,
      expiresAt: params.expiresAt,
    }),
    templateName: "membership-cancellation-confirmation",
    templateData: {
      firstName: params.firstName,
      requesterName: params.requesterName,
      participantName: params.participantName,
      token: params.token,
      confirmationUrl,
      expiresAt: formatNZDateTime(params.expiresAt),
    },
  });
}

export async function sendMembershipCancellationApprovedEmail(params: {
  email: string;
  firstName: string;
  participantName: string;
  reason?: string | null;
  adminNote?: string | null;
  rejoinProcessText?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Membership cancellation approved — ${CLUB_BOOKINGS_NAME}`,
    html: membershipCancellationApprovedTemplate(params),
    templateName: "membership-cancellation-approved",
    templateData: {
      firstName: params.firstName,
      participantName: params.participantName,
      reason: params.reason ?? "",
      adminNote: params.adminNote ?? "",
      rejoinProcessText: params.rejoinProcessText ?? "",
    },
  });
}

export async function sendMemberArchiveApprovedEmail(params: {
  email: string;
  firstName: string;
  reason: string;
  reviewNote?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Membership archive completed — ${CLUB_BOOKINGS_NAME}`,
    html: memberArchiveApprovedTemplate(params),
    templateName: "member-archive-approved",
    templateData: {
      firstName: params.firstName,
      reason: params.reason,
      reviewNote: params.reviewNote ?? "",
    },
  });
}

export async function sendMemberArchiveRejectedEmail(params: {
  email: string;
  firstName: string;
  reason: string;
  reviewNote?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Membership archive request update — ${CLUB_BOOKINGS_NAME}`,
    html: memberArchiveRejectedTemplate(params),
    templateName: "member-archive-rejected",
    templateData: {
      firstName: params.firstName,
      reason: params.reason,
      reviewNote: params.reviewNote ?? "",
    },
  });
}

export async function sendMembershipCancellationRejectedEmail(params: {
  email: string;
  firstName: string;
  participantName: string;
  reason?: string | null;
  adminNote?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Membership cancellation update — ${CLUB_BOOKINGS_NAME}`,
    html: membershipCancellationRejectedTemplate(params),
    templateName: "membership-cancellation-rejected",
    templateData: {
      firstName: params.firstName,
      participantName: params.participantName,
      reason: params.reason ?? "",
      adminNote: params.adminNote ?? "",
    },
  });
}

export interface AgeUpInvitationEmailContext {
  targetAgeTier?: string;
  targetAgeTierLabel?: string;
  targetAgeTierMinAge?: number;
}

// Age-up invitation email (sent when youth reaches the ADULT age tier)
export async function sendAgeUpInvitationEmail(
  email: string,
  firstName: string,
  token: string,
  context: AgeUpInvitationEmailContext = {},
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;
  const targetAgeTier = context.targetAgeTier ?? "ADULT";
  const targetAgeTierLabel =
    context.targetAgeTierLabel?.trim() || "Adult (18+)";
  const targetAgeTierMinAge = context.targetAgeTierMinAge ?? 18;

  await sendEmail({
    to: email,
    subject: `You're now ${targetAgeTierLabel} — set up your ${CLUB_NAME} account`,
    html: ageUpInvitationTemplate(firstName, resetUrl, {
      targetAgeTierLabel,
    }),
    templateName: "age-up-invitation",
    templateData: {
      firstName,
      token,
      resetUrl,
      targetAgeTier,
      targetAgeTierLabel,
      targetAgeTierMinAge,
    },
  });
}

export interface AgeUpParentEmailHandoffEmailContext {
  recipientName: string;
  memberFirstName: string;
  memberLastName: string;
  targetAgeTier?: string;
  targetAgeTierLabel?: string;
  targetAgeTierMinAge?: number;
}

// Age-up parent handoff email (sent when the ageing-up member still shares a login email)
export async function sendAgeUpParentEmailHandoffEmail(
  email: string,
  context: AgeUpParentEmailHandoffEmailContext,
) {
  const targetAgeTier = context.targetAgeTier ?? "ADULT";
  const targetAgeTierLabel =
    context.targetAgeTierLabel?.trim() || "Adult (18+)";
  const targetAgeTierMinAge = context.targetAgeTierMinAge ?? 18;
  const memberName = [context.memberFirstName, context.memberLastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  await sendEmail({
    to: email,
    subject: `Email address needed for ${memberName}'s ${CLUB_NAME} login`,
    html: ageUpParentEmailHandoffTemplate({
      recipientName: context.recipientName,
      memberFirstName: context.memberFirstName,
      memberLastName: context.memberLastName,
      targetAgeTierLabel,
    }),
    templateName: "age-up-parent-email-handoff",
    templateData: {
      recipientName: context.recipientName,
      memberName,
      firstName: context.memberFirstName,
      targetAgeTier,
      targetAgeTierLabel,
      targetAgeTierMinAge,
    },
  });
}
