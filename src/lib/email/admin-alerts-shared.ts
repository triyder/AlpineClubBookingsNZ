import {
  ADMIN_NOTIFICATION_PREFERENCE_SELECT,
  type AdminNotificationPreferenceKey,
  resolveAdminNotificationPreferences,
} from "../admin-notification-preferences";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { type EmailTemplateData } from "@/lib/email-message-renderer";
import {
  shouldSendAdminSystemEmail,
} from "@/lib/notification-delivery-policies";
import {
  recordAdminAlertDeliveryEscalation,
  type AdminAlertRecipientDeliveryOutcome,
} from "@/lib/email-admin-alert-escalation";
import { sendEmail } from "./core";
import { type EmailAttachment } from "./internal";

// test seam
/** Get all active admin emails */
export async function getAdminEmails(): Promise<string[]> {
  const admins = await prisma.member.findMany({
    where: { role: "ADMIN", active: true },
    select: { email: true },
  });
  return admins.map((a) => a.email);
}

async function getAdminAlertEmails(
  preferenceKey: AdminNotificationPreferenceKey,
): Promise<string[]> {
  const admins = await prisma.member.findMany({
    where: { role: "ADMIN", active: true },
    select: {
      email: true,
      notificationPreference: {
        select: ADMIN_NOTIFICATION_PREFERENCE_SELECT,
      },
    },
  });

  return admins
    .filter(
      (admin) =>
        resolveAdminNotificationPreferences(admin.notificationPreference)[
          preferenceKey
        ],
    )
    .map((admin) => admin.email);
}

/** Send an email to all active admins who opted into the alert category. */
export async function sendToAdmins({
  subject,
  html,
  templateName,
  preferenceKey,
  templateData,
  attachments,
}: {
  subject: string;
  html: string;
  templateName: string;
  preferenceKey: AdminNotificationPreferenceKey;
  templateData?: EmailTemplateData;
  attachments?: EmailAttachment[];
}) {
  const delivery = await shouldSendAdminSystemEmail({ templateName });
  if (!delivery.send) {
    logger.info(
      { templateName, deliveryMode: delivery.mode, reason: delivery.reason },
      "Skipped admin email by delivery policy",
    );
    return;
  }

  const emails = await getAdminAlertEmails(preferenceKey);
  const outcomes = await Promise.all(
    emails.map(async (email): Promise<AdminAlertRecipientDeliveryOutcome> => {
      try {
        const outcome = await sendEmail({
          to: email,
          subject,
          html,
          templateName,
          templateData,
          attachments,
        });

        // Admin alert recipients are real admin addresses, never walk-in
        // placeholders (#1935); fold the not-sent outcomes into "suppressed".
        return { status: outcome.status === "sent" ? "sent" : "suppressed" };
      } catch (err) {
        logger.error(
          { err, to: email, templateName },
          "Failed to send admin alert",
        );
        return { status: "failed" };
      }
    }),
  );

  if (
    outcomes.length > 0 &&
    outcomes.every((outcome) => outcome.status !== "sent")
  ) {
    await recordAdminAlertDeliveryEscalation({
      templateName,
      preferenceKey,
      outcomes,
    }).catch((err) =>
      logger.error(
        { err, templateName },
        "Failed to record undeliverable admin alert escalation",
      ),
    );
  }
}

export async function shouldSendDirectAdminSystemEmail(templateName: string) {
  const delivery = await shouldSendAdminSystemEmail({ templateName });
  if (!delivery.send) {
    logger.info(
      { templateName, deliveryMode: delivery.mode, reason: delivery.reason },
      "Skipped direct admin email by delivery policy",
    );
    return false;
  }
  return true;
}
