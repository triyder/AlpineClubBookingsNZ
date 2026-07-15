import { prisma } from "./prisma";
import nodemailer from "nodemailer";
import { EMAIL_FROM, formatEmailFromAddress } from "./email-sender";
import { htmlToPlainText } from "./email-text";
import logger from "@/lib/logger";
import { resolveEmailDeliveryConfig } from "@/lib/email-delivery";
import { getActiveEmailSuppression } from "@/lib/email-suppression";

const MAX_ATTEMPTS = 3;
const RETRY_FAILURE_ALERT_TEMPLATE = "admin-email-failure";

/**
 * N-11: Retry failed emails with backoff.
 * Queries EmailLog for FAILED records with attempts < 3 and re-sends.
 * Token-bearing templates are intentionally excluded because their HTML bodies
 * are not retained in EmailLog.
 * SES/SNS bounce and complaint feedback marks undeliverable messages as
 * BOUNCED, so they are excluded from retry recovery. Suppression is
 * re-checked per row before each retry send (F26, #1885) because a FAILED
 * row can predate the suppression that SNS feedback created.
 * Each row is claimed (FAILED -> QUEUED) with a guarded update before the
 * send so an interrupted or concurrent run can never deliver the same email
 * twice (F33, #1885).
 * Runs every 30 minutes.
 */
export async function retryFailedEmails(): Promise<{
  retried: number;
  succeeded: number;
  failed: number;
}> {
  const emailDelivery = resolveEmailDeliveryConfig();
  if (!emailDelivery.ok || !emailDelivery.transportOptions) {
    throw new Error(
      `Email retry skipped: delivery config invalid (${emailDelivery.issues.join("; ")})`,
    );
  }
  const transporter = nodemailer.createTransport(
    emailDelivery.transportOptions,
  );

  // Backoff: don't retry emails until at least 15 minutes after the last attempt
  const backoffThreshold = new Date(Date.now() - 15 * 60 * 1000);

  const failedEmails = await prisma.emailLog.findMany({
    where: {
      status: "FAILED",
      attempts: { lt: MAX_ATTEMPTS },
      htmlBody: { not: null },
      lastAttemptAt: { not: { gte: backoffThreshold } },
    },
    orderBy: { createdAt: "asc" },
    take: 50, // Process in batches to avoid overload
  });

  let retried = 0;
  let succeeded = 0;
  let failed = 0;

  for (const emailLog of failedEmails) {
    // F26 (#1885): a FAILED row can be created before an SNS bounce/complaint
    // suppresses the recipient (the pre-send check in core.ts passed, then the
    // SMTP send failed after the suppression landed). Re-check here so a
    // suppressed recipient is never re-delivered. Mirrors core.ts: on check
    // failure proceed (fail-open, same as the pre-send path); on an active
    // suppression mark the row BOUNCED with the same reason string and drop
    // the retained body.
    const activeSuppression = await getActiveEmailSuppression(
      emailLog.to,
    ).catch((err) => {
      logger.error(
        { err, to: emailLog.to, templateName: emailLog.templateName },
        "Failed to check email suppression state before retry",
      );
      return null;
    });

    if (activeSuppression) {
      await prisma.emailLog
        .update({
          where: { id: emailLog.id },
          data: {
            status: "BOUNCED",
            htmlBody: null,
            errorMessage: `Email suppressed after SES ${activeSuppression.reason.toLowerCase()} feedback`,
          },
        })
        .catch((err) => {
          logger.error(
            { err, emailLogId: emailLog.id },
            "Failed to update suppressed email log during retry",
          );
        });
      logger.warn(
        {
          to: emailLog.to,
          templateName: emailLog.templateName,
          emailSuppressionId: activeSuppression.id,
          reason: activeSuppression.reason,
        },
        "Skipped email retry to suppressed recipient",
      );
      // A suppressed skip is not a retry attempt.
      continue;
    }

    const newAttempts = emailLog.attempts + 1;

    // F33 (#1885): claim the row before sending. If a previous run crashed
    // after SES accepted the message but before the SENT write committed, the
    // row is no longer FAILED, the claim finds nothing, and we never
    // double-send. Two overlapping cron runs race the same guarded update and
    // only one wins.
    const claim = await prisma.emailLog.updateMany({
      where: { id: emailLog.id, status: "FAILED" },
      data: {
        status: "QUEUED",
        attempts: newAttempts,
        lastAttemptAt: new Date(),
      },
    });
    if (claim.count !== 1) {
      // Already claimed (or resolved) by another run — not a retry attempt.
      continue;
    }

    retried++;

    if (process.env.NODE_ENV === "development") {
      logger.info(
        { to: emailLog.to, subject: emailLog.subject },
        "Email retry (dev mode)",
      );
      await prisma.emailLog
        .update({
          where: { id: emailLog.id },
          data: {
            status: "SENT",
            sentAt: new Date(),
            errorMessage: null,
          },
        })
        .catch((err) => {
          logger.error(
            { err, emailLogId: emailLog.id },
            "Failed to update EmailLog to SENT after dev-mode retry",
          );
        });
      succeeded++;
      continue;
    }

    let result: Awaited<ReturnType<typeof transporter.sendMail>>;
    try {
      result = await transporter.sendMail({
        from: formatEmailFromAddress(EMAIL_FROM),
        to: emailLog.to,
        subject: emailLog.subject,
        html: emailLog.htmlBody!,
        text: htmlToPlainText(emailLog.htmlBody!),
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, emailLogId: emailLog.id, attempt: newAttempts },
        "Email retry failed",
      );

      await prisma.emailLog
        .update({
          where: { id: emailLog.id },
          data: {
            // Restore FAILED (the claim moved the row to QUEUED) — will
            // retry again if attempts < MAX.
            status: "FAILED",
            attempts: newAttempts,
            lastAttemptAt: new Date(),
            errorMessage,
          },
        })
        .catch((updateErr) => {
          logger.error(
            { err: updateErr, emailLogId: emailLog.id },
            "Failed to update EmailLog after retry failure",
          );
        });

      // Alert admin when email exhausts retries
      if (
        newAttempts >= MAX_ATTEMPTS &&
        emailLog.templateName !== RETRY_FAILURE_ALERT_TEMPLATE
      ) {
        try {
          const { sendEmail } = await import("./email");
          const admins = await prisma.member.findMany({
            where: { role: "ADMIN", active: true },
            select: { email: true },
          });
          for (const admin of admins) {
            await sendEmail({
              to: admin.email,
              subject: "Email delivery permanently failed",
              html: `<p>Email to ${emailLog.to} (template: ${emailLog.templateName}) has failed after ${newAttempts} attempts and will not be retried.</p>`,
              templateName: RETRY_FAILURE_ALERT_TEMPLATE,
              templateData: {
                originalRecipient: emailLog.to,
                originalTemplateName: emailLog.templateName,
                attemptCount: newAttempts,
              },
            }).catch(() => {}); // Don't let alert failure break the cron
          }
        } catch {
          // Non-critical
        }
      }

      failed++;
      continue;
    }

    // The provider accepted the message. If this SENT write fails, leave the
    // row QUEUED (claimed) rather than restoring FAILED: a FAILED row would
    // be re-sent on the next run even though the email already went out
    // (F33, #1885). At-most-once beats a duplicate money-adjacent email.
    await prisma.emailLog
      .update({
        where: { id: emailLog.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          messageId: result.messageId || null,
          errorMessage: null,
        },
      })
      .catch((err) => {
        logger.error(
          { err, emailLogId: emailLog.id },
          "Failed to update EmailLog to SENT after retry; leaving the row QUEUED so it is not re-sent",
        );
      });
    succeeded++;
  }

  return { retried, succeeded, failed };
}
