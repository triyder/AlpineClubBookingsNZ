import { EMAIL_FROM } from "../email-sender";
import { htmlToPlainText } from "../email-text";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  formatEmailFromAddressWithSettings,
} from "@/lib/email-message-settings";
import {
  prepareEmailMessage,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";
import {
  getActiveEmailSuppression,
  normalizeEmailAddress,
} from "@/lib/email-suppression";
import {
  getEmailTransporter,
  shouldPersistEmailHtml,
  type EmailAttachment,
} from "./internal";

export type EmailSendOutcome =
  | {
      status: "sent";
      emailLogId: string | null;
      messageId: string | null;
    }
  | {
      status: "suppressed";
      emailLogId: string | null;
      emailSuppressionId: string;
      reason: string;
    };

function assertNoCrlf(value: string, field: string) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Email header field ${field} contains CR/LF`);
  }
}

// Defense-in-depth: subject lines interpolate user-controlled member names
// (issue #323). Schema-level sanitization at API boundaries is the first line
// of defense, but a contaminated row from before the fix would still trip the
// CRLF guard on `from`/`to`. Strip CRLF from the subject before send so the
// email never silently fails — `from`/`to` keep the throw because CRLF there
// indicates a configuration/normalizer bug, not user input.
function sanitizeEmailSubject(subject: string) {
  return subject.replace(/[\r\n]+/g, " ").trim();
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
  templateName = "unknown",
  templateData,
  attachments,
  logRecipient,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  templateName?: string;
  templateData?: EmailTemplateData;
  attachments?: EmailAttachment[];
  logRecipient?: string;
}): Promise<EmailSendOutcome> {
  const prepared = await prepareEmailMessage({
    templateName,
    subject,
    html,
    templateData,
  });
  const from = formatEmailFromAddressWithSettings(
    prepared.settings,
    EMAIL_FROM,
  );
  const plainTextBody = text || htmlToPlainText(prepared.html);
  const normalizedRecipient = normalizeEmailAddress(to);
  const emailLogRecipient = logRecipient?.trim() || to;
  const recipientRedactedInLogs = emailLogRecipient !== to;
  const persistHtmlBody =
    !recipientRedactedInLogs && shouldPersistEmailHtml(templateName);
  const sanitizedSubject = sanitizeEmailSubject(prepared.subject);

  assertNoCrlf(from, "from");
  assertNoCrlf(to, "to");
  assertNoCrlf(normalizedRecipient, "to");
  assertNoCrlf(emailLogRecipient, "logRecipient");

  // Create EmailLog record (fire-and-forget logging won't break email delivery)
  let emailLogId: string | null = null;
  try {
    const log = await prisma.emailLog.create({
      data: {
        to: emailLogRecipient,
        subject: sanitizedSubject,
        templateName,
        htmlBody: persistHtmlBody ? prepared.html : null,
        status: "QUEUED",
        lastAttemptAt: new Date(),
      },
    });
    emailLogId = log.id;
  } catch (err) {
    logger.error({ err }, "Failed to create EmailLog record");
  }

  const activeSuppression = await getActiveEmailSuppression(
    normalizedRecipient,
  ).catch((err) => {
    logger.error(
      { err, to: emailLogRecipient, templateName },
      "Failed to check email suppression state",
    );
    return null;
  });

  if (activeSuppression) {
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            status: "BOUNCED",
            htmlBody: null,
            errorMessage: `Email suppressed after SES ${activeSuppression.reason.toLowerCase()} feedback`,
          },
        });
      } catch (err) {
        logger.error(
          { err, to: emailLogRecipient },
          "Failed to update suppressed email log",
        );
      }
    }

    logger.warn(
      {
        to: emailLogRecipient,
        templateName,
        emailSuppressionId: activeSuppression.id,
        reason: activeSuppression.reason,
      },
      "Skipped email to suppressed recipient",
    );
    return {
      status: "suppressed",
      emailLogId,
      emailSuppressionId: activeSuppression.id,
      reason: activeSuppression.reason,
    };
  }

  if (process.env.NODE_ENV === "development") {
    logger.info(
      { to: emailLogRecipient, subject: sanitizedSubject, templateName },
      "Email sent (dev mode)",
    );
    if (persistHtmlBody) {
      logger.debug({ html: prepared.html }, "Email HTML content");
    } else {
      logger.debug(
        { templateName },
        "Email HTML content redacted for sensitive template",
      );
    }
    // Mark as SENT in dev mode
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: { status: "SENT", sentAt: new Date() },
        });
      } catch (err) {
        logger.error(
          { err, to: emailLogRecipient, templateName },
          "Failed to update EmailLog",
        );
      }
    }
    return {
      status: "sent",
      emailLogId,
      messageId: null,
    };
  }

  try {
    const { transporter, modeLabel } = getEmailTransporter();
    const result = await transporter.sendMail({
      from,
      to,
      subject: sanitizedSubject,
      html: prepared.html,
      text: plainTextBody,
      attachments,
    });

    logger.debug(
      { templateName, to: emailLogRecipient, mode: modeLabel },
      "Email delivered",
    );

    // Update EmailLog to SENT
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            status: "SENT",
            sentAt: new Date(),
            messageId: result.messageId || null,
          },
        });
      } catch (err) {
        logger.error({ err }, "Failed to update EmailLog to SENT");
      }
    }
    return {
      status: "sent",
      emailLogId,
      messageId: result.messageId || null,
    };
  } catch (err) {
    // Update EmailLog to FAILED
    if (emailLogId) {
      try {
        await prisma.emailLog.update({
          where: { id: emailLogId },
          data: {
            status: "FAILED",
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
      } catch (logErr) {
        logger.error({ err: logErr }, "Failed to update EmailLog to FAILED");
      }
    }
    if (!persistHtmlBody) {
      logger.warn(
        { templateName },
        "Sensitive email delivery failed and cannot be automatically retried because HTML retention is disabled",
      );
    }
    throw err;
  }
}

/**
 * N-08: Check notification preferences before sending a member email.
 * Maps template categories to preference fields.
 * Admin alerts bypass preferences entirely.
 */
const CATEGORY_TO_PREFERENCE: Record<
  string,
  keyof Omit<
    import("@prisma/client").NotificationPreference,
    "id" | "memberId" | "createdAt" | "updatedAt"
  >
> = {
  bookingConfirmation: "bookingConfirmation",
  bookingReminder: "bookingReminder",
  bookingBumped: "bookingBumped",
  bookingCancelled: "bookingCancelled",
  choreRoster: "choreRoster",
  bookingWaitlist: "bookingWaitlist",
  marketingEmails: "marketingEmails",
};

export async function shouldSendEmail(
  memberId: string,
  category: string,
): Promise<boolean> {
  const prefField = CATEGORY_TO_PREFERENCE[category];
  if (!prefField) {
    // Unknown category — default to sending
    return true;
  }

  const pref = await prisma.notificationPreference.findUnique({
    where: { memberId },
  });

  if (!pref) {
    // No preference record = defaults (all true except marketingEmails)
    return category !== "marketingEmails";
  }

  return Boolean(pref[prefField]);
}
