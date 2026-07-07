import {
  passwordResetTemplate,
  emailVerificationTemplate,
  emailChangeVerificationTemplate,
  emailChangeNotificationTemplate,
  adminPasswordResetTemplate,
  memberSetupInviteTemplate,
  twoFactorCodeTemplate,
  accountDeletionApprovedTemplate,
  accountDeletionRejectedTemplate,
} from "../email-templates";
import {
  CLUB_BOOKINGS_NAME,
  CLUB_NAME,
} from "@/config/club-identity";
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "../member-setup-invite";
import { formatNZDateTime } from "../nzst-date";
import {
  EMAIL_CHANGE_TTL_MS,
  EMAIL_VERIFICATION_TTL_MS,
} from "@/lib/verification-tokens";
import { sendEmail } from "./core";

export async function sendPasswordResetEmail(email: string, token: string) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: `Reset your ${CLUB_NAME} password`,
    html: passwordResetTemplate(resetUrl),
    templateName: "password-reset",
    templateData: { token, resetUrl },
  });
}

export async function sendAdminPasswordResetEmail(
  email: string,
  token: string,
  expiryLabel = "1 hour",
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: `Reset your ${CLUB_NAME} password`,
    html: adminPasswordResetTemplate(resetUrl, expiryLabel),
    templateName: "admin-password-reset",
    templateData: { token, resetUrl, expiryLabel },
  });
}

export async function sendMemberSetupInviteEmail(
  email: string,
  firstName: string,
  token: string,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: `Set up your ${CLUB_NAME} account (${MEMBER_SETUP_INVITE_TTL_DAYS}-day link)`,
    html: memberSetupInviteTemplate(firstName, resetUrl),
    templateName: "member-setup-invite",
    templateData: {
      firstName,
      token,
      resetUrl,
      expiryLabel: `${MEMBER_SETUP_INVITE_TTL_DAYS} days`,
    },
  });
}

export async function sendTwoFactorCodeEmail(params: {
  email: string;
  firstName: string;
  code: string;
  expiresAt: Date;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your ${CLUB_NAME} two-factor code`,
    html: twoFactorCodeTemplate(params),
    templateName: "two-factor-code",
    templateData: {
      firstName: params.firstName,
      code: params.code,
      expiresAt: formatNZDateTime(params.expiresAt),
    },
  });
}

export async function sendVerificationEmail(
  email: string,
  firstName: string,
  token: string,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/verify-email?token=${token}`;
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  await sendEmail({
    to: email,
    subject: `Verify your email — ${CLUB_BOOKINGS_NAME}`,
    html: emailVerificationTemplate(firstName, verifyUrl, expiresAt),
    templateName: "email-verification",
    templateData: {
      firstName,
      token,
      verifyUrl,
      expiresAt: formatNZDateTime(expiresAt),
    },
  });
}

export async function sendEmailChangeVerification(
  newEmail: string,
  token: string,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/confirm-email-change?token=${token}`;
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS);

  await sendEmail({
    to: newEmail,
    subject: `Confirm your new email — ${CLUB_BOOKINGS_NAME}`,
    html: emailChangeVerificationTemplate(newEmail, verifyUrl, expiresAt),
    templateName: "email-change-verification",
    templateData: {
      newEmail,
      token,
      verifyUrl,
      expiresAt: formatNZDateTime(expiresAt),
    },
  });
}

export async function sendEmailChangeNotification(
  oldEmail: string,
  newEmail: string,
) {
  await sendEmail({
    to: oldEmail,
    subject: `Email change requested — ${CLUB_BOOKINGS_NAME}`,
    html: emailChangeNotificationTemplate(newEmail),
    templateName: "email-change-notification",
    templateData: { newEmail },
  });
}

// F-COMP-04: Account deletion approved
export async function sendAccountDeletionApprovedEmail(
  email: string,
  firstName: string,
) {
  await sendEmail({
    to: email,
    subject: "Your Account Deletion Request Has Been Processed",
    html: accountDeletionApprovedTemplate(firstName),
    templateName: "account-deletion-approved",
    templateData: { firstName },
  });
}

// F-COMP-04: Account deletion rejected
export async function sendAccountDeletionRejectedEmail(
  email: string,
  firstName: string,
  adminNote: string,
) {
  await sendEmail({
    to: email,
    subject: "Update on Your Account Deletion Request",
    html: accountDeletionRejectedTemplate(firstName, adminNote),
    templateName: "account-deletion-rejected",
    templateData: { firstName, adminNote },
  });
}
