import nodemailer from "nodemailer";
import { resolveEmailDeliveryConfig } from "@/lib/email-delivery";

export type EmailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

let cachedTransporter: nodemailer.Transporter | null = null;
let cachedTransportSignature: string | null = null;

export function getEmailTransporter() {
  const config = resolveEmailDeliveryConfig();
  if (!config.ok || !config.transportOptions) {
    throw new Error(
      `Email delivery is not configured: ${config.issues.join("; ")}`,
    );
  }

  const signature = `${config.mode}:${config.transportOptions.host}:${config.transportOptions.port}:${config.transportOptions.auth.user}`;
  if (!cachedTransporter || cachedTransportSignature !== signature) {
    cachedTransporter = nodemailer.createTransport(config.transportOptions);
    cachedTransportSignature = signature;
  }

  return { transporter: cachedTransporter, modeLabel: config.modeLabel };
}

// Token-bearing emails should never persist their rendered HTML in logs or retry
// tables because that would retain live reset/verification links at rest.
const SENSITIVE_EMAIL_LOG_TEMPLATES = new Set([
  "password-reset",
  "admin-password-reset",
  "member-setup-invite",
  "email-verification",
  "email-change-verification",
  "two-factor-code",
  "age-up-invitation",
  "nomination-request",
  "partner-invite",
  "membership-application-approved",
  "membership-cancellation-confirmation",
  "hut-leader-assignment",
  "booking-confirmed",
  "pre-arrival-reminder",
  "booking-request-verification",
  "booking-request-approved",
  "booking-request-quote",
  "school-attendee-confirmation",
  "group-booking-join-verification",
  "chore-roster",
]);

// Failure-alert emails should also skip HTML retention so a broken admin
// mailbox or SMTP path cannot recurse into retrying the retry-failure alert.
const NON_RETRYABLE_EMAIL_LOG_TEMPLATES = new Set([
  ...SENSITIVE_EMAIL_LOG_TEMPLATES,
  "admin-email-failure",
]);

export function shouldPersistEmailHtml(templateName: string): boolean {
  return !NON_RETRYABLE_EMAIL_LOG_TEMPLATES.has(templateName);
}
