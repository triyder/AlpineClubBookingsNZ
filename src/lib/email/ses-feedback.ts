import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  normalizeEmailAddress,
  recordSesEmailFeedback,
  type SesEmailFeedbackEvent,
} from "@/lib/email-suppression";

type SesSnsNotification = {
  Type?: string;
  Message?: string;
  notificationType?: string;
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: Array<{ emailAddress?: string }>;
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: Array<{ emailAddress?: string }>;
  };
  mail?: {
    destination?: string[];
    messageId?: string;
  };
};

function parseSesSnsNotification(payload: unknown): SesSnsNotification | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const envelope = payload as SesSnsNotification;
  if (typeof envelope.Message === "string") {
    try {
      return parseSesSnsNotification(JSON.parse(envelope.Message));
    } catch {
      return null;
    }
  }

  return envelope;
}

function getSesFeedbackRecipients(
  notification: SesSnsNotification,
  kind: "bounce" | "complaint",
) {
  const recipients =
    kind === "bounce"
      ? notification.bounce?.bouncedRecipients?.map(
          (entry) => entry.emailAddress,
        )
      : notification.complaint?.complainedRecipients?.map(
          (entry) => entry.emailAddress,
        );

  return (recipients ?? notification.mail?.destination ?? []).filter(
    (email): email is string => Boolean(email),
  );
}

export async function ingestSesSnsEmailFeedback(payload: unknown) {
  const notification = parseSesSnsNotification(payload);
  if (!notification) {
    return { handled: false as const };
  }
  const notificationType = notification.notificationType?.toLowerCase();
  if (notificationType !== "bounce" && notificationType !== "complaint") {
    return { handled: false as const };
  }

  const recipients = getSesFeedbackRecipients(notification, notificationType);
  if (recipients.length === 0) {
    return { handled: false as const };
  }
  const normalizedRecipients = recipients.map(normalizeEmailAddress);
  const logRecipients = Array.from(
    new Set([...recipients, ...normalizedRecipients]),
  );

  await prisma.emailLog.updateMany({
    where: {
      to: { in: logRecipients },
      status: { in: ["QUEUED", "SENT", "FAILED"] },
    },
    data: {
      status: "BOUNCED",
      errorMessage: `SES ${notificationType} received via SNS`,
    },
  });

  const suppressionResult = await recordSesEmailFeedback(
    normalizedRecipients.map(
      (email): SesEmailFeedbackEvent => ({
        email,
        reason: notificationType === "complaint" ? "COMPLAINT" : "BOUNCE",
        eventType: notificationType,
        sesMessageId: notification.mail?.messageId ?? null,
        bounceType: notification.bounce?.bounceType ?? null,
        bounceSubType: notification.bounce?.bounceSubType ?? null,
        complaintFeedbackType:
          notification.complaint?.complaintFeedbackType ?? null,
      }),
    ),
  );

  logger.warn(
    {
      sesNotificationType: notificationType,
      sesMessageId: notification.mail?.messageId ?? null,
      recipients: normalizedRecipients,
      suppressionsProcessed: suppressionResult.processed,
      suppressionsActive: suppressionResult.suppressed,
    },
    "Processed SES/SNS email delivery feedback",
  );

  return {
    handled: true as const,
    notificationType,
    recipients: normalizedRecipients,
    suppressionsProcessed: suppressionResult.processed,
    suppressionsActive: suppressionResult.suppressed,
  };
}
