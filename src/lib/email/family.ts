import {
  familyGroupInvitationTemplate,
  familyGroupInviteAcceptedTemplate,
  childRequestSubmittedTemplate,
  childRequestApprovedTemplate,
  childRequestRejectedTemplate,
  joinRequestConfirmationTemplate,
  groupCreateRequestConfirmationTemplate,
  groupCreateApprovedTemplate,
  groupCreateRejectedTemplate,
} from "../email-templates";
import { CLUB_BOOKINGS_NAME } from "@/config/club-identity";
import { sendEmail } from "./core";

// ---- Family group emails ----

export async function sendFamilyGroupInvitationEmail(
  email: string,
  inviterName: string,
  groupName: string,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const profileUrl = `${baseUrl}/profile`;

  await sendEmail({
    to: email,
    subject: `${inviterName} invited you to join ${groupName} — ${CLUB_BOOKINGS_NAME}`,
    html: familyGroupInvitationTemplate(inviterName, groupName, profileUrl),
    templateName: "family-group-invitation",
    templateData: { inviterName, groupName, profileUrl },
  });
}

export async function sendFamilyGroupInviteAcceptedEmail(
  email: string,
  inviteeName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `${inviteeName} has joined ${groupName} — ${CLUB_BOOKINGS_NAME}`,
    html: familyGroupInviteAcceptedTemplate(inviteeName, groupName),
    templateName: "family-group-invite-accepted",
    templateData: { inviteeName, groupName },
  });
}

export async function sendChildRequestSubmittedEmail(
  email: string,
  parentName: string,
  childName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `Infant/Child/Youth request submitted — ${CLUB_BOOKINGS_NAME}`,
    html: childRequestSubmittedTemplate(parentName, childName, groupName),
    templateName: "child-request-submitted",
    templateData: { parentName, childName, groupName },
  });
}

export async function sendChildRequestApprovedEmail(
  email: string,
  parentName: string,
  childName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `${childName} has been added to ${groupName} — ${CLUB_BOOKINGS_NAME}`,
    html: childRequestApprovedTemplate(parentName, childName, groupName),
    templateName: "child-request-approved",
    templateData: { parentName, childName, groupName },
  });
}

export async function sendChildRequestRejectedEmail(
  email: string,
  parentName: string,
  childName: string,
  reason?: string,
) {
  await sendEmail({
    to: email,
    subject: `Infant/Child/Youth request update — ${CLUB_BOOKINGS_NAME}`,
    html: childRequestRejectedTemplate(parentName, childName, reason),
    templateName: "child-request-rejected",
    templateData: { parentName, childName, reason: reason ?? "" },
  });
}

// P3.4: Confirmation email to requester on join request
export async function sendJoinRequestConfirmationEmail(
  email: string,
  requesterName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `Join request submitted — ${CLUB_BOOKINGS_NAME}`,
    html: joinRequestConfirmationTemplate(requesterName, groupName),
    templateName: "join-request-confirmation",
    templateData: { requesterName, groupName },
  });
}

// ---- Member-initiated "create group from scratch" flow (#1681) ----

export async function sendGroupCreateRequestConfirmationEmail(
  email: string,
  requesterName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `Family group request submitted — ${CLUB_BOOKINGS_NAME}`,
    html: groupCreateRequestConfirmationTemplate(requesterName, groupName),
    templateName: "family-group-create-request-confirmation",
    templateData: { requesterName, groupName },
  });
}

export async function sendGroupCreateApprovedEmail(
  email: string,
  requesterName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `Your family group ${groupName} has been created — ${CLUB_BOOKINGS_NAME}`,
    html: groupCreateApprovedTemplate(requesterName, groupName),
    templateName: "family-group-create-approved",
    templateData: { requesterName, groupName },
  });
}

export async function sendGroupCreateRejectedEmail(
  email: string,
  requesterName: string,
  groupName: string,
  reason?: string,
) {
  await sendEmail({
    to: email,
    subject: `Family group request update — ${CLUB_BOOKINGS_NAME}`,
    html: groupCreateRejectedTemplate(requesterName, groupName, reason),
    templateName: "family-group-create-rejected",
    templateData: { requesterName, groupName, reason: reason ?? "" },
  });
}
