import {
  EMAIL_AUDIT_DEFAULTS,
  type EmailAuditTemplateName,
} from "@/lib/email-message-audit-defaults";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";

type EmailTemplateAudience = "member" | "admin" | "system";
export type NotificationDeliveryModeValue = "always" | "content_only" | "disabled";

export interface EmailTemplateDefinition {
  key: EmailAuditTemplateName;
  label: string;
  audience: EmailTemplateAudience;
  defaultSubject: string;
  defaultBody: string;
  allowedTokens: string[];
  requiredTokens: string[];
  sampleData: Record<string, string>;
  triggerSummary: string;
  frequency: string;
  deliveryEditable: boolean;
  defaultDeliveryMode: NotificationDeliveryModeValue;
}

const ADMIN_SYSTEM_TEMPLATE_NAMES = new Set<EmailAuditTemplateName>([
  "admin-membership-application-pending",
  "admin-minors-review",
  "admin-owner-substitution",
  "admin-partner-share-swept",
  "admin-new-booking",
  "admin-payment-failure",
  "admin-pending-deadline",
  "admin-booking-bumped",
  "admin-capacity-warning",
  "admin-daily-digest",
  "admin-xero-sync-error",
  "admin-xero-repeated-failure",
  "admin-xero-reconciliation-report",
  "admin-refund-request",
  "admin-booking-change-request",
  "admin-issue-report",
  "admin-membership-cancellation-request",
  "admin-account-deletion-requested",
  "admin-member-archive-requested",
  "admin-member-delete-requested",
  "admin-member-delete-approved",
  "admin-member-delete-rejected",
  "admin-waitlist-offer",
  "admin-family-group-request",
  "admin-email-failure",
  "website-contact",
  "admin-booking-request-pending",
  "admin-booking-request-hold-expired",
  "admin-school-manual-invoice",
  // #1967/#1994: split non-member guest portion unpaid at hold expiry (no card
  // on file). Ships via sendToAdmins, so it classifies as an admin alert.
  // Deliberately NOT in LOCKED_DELIVERY_TEMPLATE_NAMES — it is an operational
  // nudge (the member already has their payment link; no money is lost if an
  // admin mutes it), so admins keep full delivery-mode control. Still gated by
  // the adminPaymentFailure notification preference at send time (#1422).
  "admin-split-settlement-unpaid",
]);

// Admin/system templates whose delivery mode admins must NOT be able to change.
// admin-school-manual-invoice (#1797) is admin-facing so it classifies as an
// admin alert, but disabling it would let an approved school booking go
// un-invoiced — a money risk — so it is locked to always-send like
// admin-email-failure, matching the pre-#1797 hardcoded behaviour.
const LOCKED_DELIVERY_TEMPLATE_NAMES = new Set<EmailAuditTemplateName>([
  "admin-email-failure",
  "admin-school-manual-invoice",
]);

const CONTENT_ONLY_DEFAULT_TEMPLATE_NAMES = new Set<EmailAuditTemplateName>([
  "admin-daily-digest",
  "admin-xero-reconciliation-report",
]);

const GLOBAL_EMAIL_TEMPLATE_TOKENS = [
  "BASE_URL",
  "CLUB_BOOKINGS_NAME",
  "CLUB_EMAIL_FROM_NAME",
  "CLUB_LODGE_NAME",
  "CLUB_LODGE_TRAVEL_NOTE",
  "CLUB_NAME",
  "CONTACT_EMAIL",
  "LODGE_CAPACITY",
  "SUPPORT_EMAIL",
] as const;

const EXTRA_TEMPLATE_TOKENS: Partial<Record<EmailAuditTemplateName, string[]>> = {
  // Lodge the warning is about; empty for single-lodge clubs (ADR-002).
  "admin-capacity-warning": ["lodgeName"],
  // Split-booking parent (#738): a pre-composed sentence describing the
  // provisional non-member portion; empty for a non-split confirmation.
  "booking-confirmed": ["provisionalGuestsNote"],
  "booking-modified": [
    "additionalPaymentMethod",
    "paymentReference",
    "xeroInvoiceNumber",
  ],
  "password-reset": ["resetUrl"],
  "admin-password-reset": ["resetUrl"],
  "member-setup-invite": ["resetUrl"],
  "email-verification": ["verifyUrl"],
  "email-change-verification": ["verifyUrl"],
  "nomination-request": ["reviewUrl"],
  "membership-application-approved": ["resetUrl"],
  "admin-membership-application-pending": ["reviewUrl"],
  "family-group-invitation": ["profileUrl"],
  "partner-link-request": ["profileUrl"],
  "membership-cancellation-submitted": [
    "participantSummary",
    "reason",
    "reviewUrl",
  ],
  "membership-cancellation-confirmation": ["confirmationUrl"],
  "membership-cancellation-approved": [
    "adminNote",
    "participantName",
    "reason",
    "rejoinProcessText",
  ],
  "membership-cancellation-rejected": [
    "adminNote",
    "participantName",
    "reason",
  ],
  "admin-membership-cancellation-request": [
    "participantSummary",
    "reason",
    "reviewUrl",
  ],
  "admin-account-deletion-requested": ["reason", "requestId", "reviewUrl"],
  "admin-member-archive-requested": ["memberName", "reason", "reviewUrl"],
  "member-archive-approved": ["reason", "reviewNote"],
  "member-archive-rejected": ["reason", "reviewNote"],
  "admin-member-delete-requested": ["memberName", "reason", "reviewUrl"],
  "admin-member-delete-approved": ["memberName", "reason", "reviewNote"],
  "admin-member-delete-rejected": [
    "memberName",
    "reason",
    "reviewNote",
    "reviewUrl",
  ],
  "admin-xero-repeated-failure": ["localUrl", "xeroObjectUrl"],
  "refund-request-resolved": ["status"],
  "admin-issue-report": ["hasScreenshot"],
  "age-up-invitation": ["resetUrl", "targetAgeTier", "targetAgeTierMinAge"],
  "age-up-parent-email-handoff": ["targetAgeTier", "targetAgeTierMinAge"],
  "booking-request-verification": ["verifyUrl"],
  "booking-request-approved": ["payUrl"],
  // #1967/#1994: the send passes a pre-built {{payUrl}} alongside the raw
  // {{token}}, so allow admins to reference it in an override (mirrors
  // booking-request-approved).
  "split-guest-payment-link": ["payUrl"],
  "booking-request-quote": ["respondUrl"],
};

const REQUIRED_TEMPLATE_TOKENS: Partial<Record<EmailAuditTemplateName, string[]>> = {
  "booking-confirmed": ["CLUB_LODGE_TRAVEL_NOTE", "doorCode"],
  "pre-arrival-reminder": ["CLUB_LODGE_TRAVEL_NOTE", "doorCode"],
  "password-reset": ["token"],
  "admin-password-reset": ["token"],
  "member-setup-invite": ["token"],
  "email-verification": ["token"],
  "email-change-verification": ["newEmail", "token"],
  "email-change-notification": ["newEmail"],
  "nomination-request": ["applicantName", "token"],
  "partner-invite": ["inviterName", "token"],
  "partner-invite-claimed": ["firstName", "groupName"],
  "partner-link-request": ["requesterName"],
  "partner-link-confirmed": ["partnerName"],
  "partner-link-removed": ["partnerName"],
  "membership-application-approved": ["token"],
  "membership-cancellation-confirmation": [
    "participantName",
    "requesterName",
    "token",
  ],
  "membership-cancellation-submitted": ["participantSummary", "reviewUrl"],
  "membership-cancellation-approved": ["participantName"],
  "membership-cancellation-rejected": ["participantName"],
  "admin-membership-cancellation-request": [
    "participantSummary",
    "requesterName",
    "reviewUrl",
  ],
  "admin-account-deletion-requested": [
    "memberEmail",
    "memberName",
    "reviewUrl",
  ],
  "admin-member-archive-requested": [
    "memberName",
    "requesterName",
    "reason",
    "reviewUrl",
  ],
  "member-archive-approved": ["firstName", "reason"],
  "member-archive-rejected": ["firstName", "reason"],
  "admin-member-delete-requested": [
    "memberName",
    "requesterName",
    "reason",
    "reviewUrl",
  ],
  "admin-member-delete-approved": ["memberName", "requesterName", "reason"],
  "admin-member-delete-rejected": [
    "memberName",
    "requesterName",
    "reason",
    "reviewUrl",
  ],
  "age-up-invitation": ["token"],
  "age-up-parent-email-handoff": ["memberName"],
  "website-contact": ["name", "email", "message"],
  "admin-email-failure": [
    "originalRecipient",
    "originalTemplateName",
    "attemptCount",
  ],
  "bulk-communication": ["adminEnteredBody"],
  "booking-request-verification": ["token"],
  "booking-request-approved": ["token"],
  // #1967/#1994: the tokenised /pay/<token> bearer link is the essential body
  // content — the required "token" blocks an override that drops the pay link.
  // Sensitive-log redaction is driven separately by SENSITIVE_EMAIL_LOG_TEMPLATES
  // in src/lib/email/internal.ts, which already contains this template.
  "split-guest-payment-link": ["token"],
  "booking-request-quote": ["token"],
  "admin-booking-request-pending": ["requesterName", "reviewUrl"],
  "admin-booking-request-hold-expired": ["requesterName", "reviewUrl"],
  "admin-split-settlement-unpaid": ["memberName", "reviewUrl"],
  "admin-partner-share-swept": ["memberName", "partnerName", "reason"],
  "booking-review-approved": ["bookingId"],
  "induction-sign-off-request": ["inductionUrl"],
  "school-attendee-confirmation": ["token"],
  "group-booking-join-verification": ["token"],
};

const TEMPLATE_TRIGGER_METADATA: Partial<
  Record<EmailAuditTemplateName, { triggerSummary: string; frequency: string }>
> = {
  "admin-daily-digest": {
    triggerSummary: "Scheduled admin alert summary",
    frequency: "Daily at the configured cron time",
  },
  "admin-xero-reconciliation-report": {
    triggerSummary: "Scheduled Xero reconciliation report",
    frequency: "When the Xero reconciliation cron runs",
  },
  "admin-email-failure": {
    triggerSummary: "Exhausted retry alert",
    frequency: "When a retryable email permanently fails",
  },
  "admin-booking-change-request": {
    triggerSummary: "Locked booking change request submitted",
    frequency: "Per member/admin request submission",
  },
  "admin-minors-review": {
    triggerSummary:
      "Paid booking edited into a minors-only (no-adult) composition",
    frequency: "Once when a guest removal or batch edit newly trips the flag",
  },
  "admin-owner-substitution": {
    triggerSummary:
      "Held booking-request owner failed re-validation at conversion; a fresh contact was substituted and the invoice will bill it instead of the intended owner",
    frequency: "Once per conversion where the held owner is no longer mappable",
  },
  "admin-partner-share-swept": {
    triggerSummary:
      "A partner pair's future shared double-bed placements were swept after their link dissolved or a member stopped being an eligible sharer (#1756)",
    frequency:
      "Once per dissolve/deactivation/tier-change event that removed at least one placement",
  },
  "family-group-create-request-confirmation": {
    triggerSummary: "Member-initiated family group creation request submitted",
    frequency: "Per group creation request",
  },
  "family-group-create-approved": {
    triggerSummary: "Family group creation request approved by admin",
    frequency: "Per group creation approval",
  },
  "family-group-create-rejected": {
    triggerSummary: "Family group creation request rejected by admin",
    frequency: "Per group creation rejection",
  },
  "partner-invite": {
    triggerSummary: "Partner without an account invited to a family group",
    frequency: "Per partner invitation minted",
  },
  "partner-invite-claimed": {
    triggerSummary: "Invited partner registered and claimed their invitation",
    frequency: "Per partner invitation claimed",
  },
  "partner-link-request": {
    triggerSummary: "Member asked another member to confirm a partner relationship",
    frequency: "Per partner link request",
  },
  "partner-link-confirmed": {
    triggerSummary: "Partner relationship confirmed (accepted, claimed, or admin-recorded)",
    frequency: "Per partner link confirmation",
  },
  "partner-link-removed": {
    triggerSummary: "Confirmed partner relationship removed",
    frequency: "Per partner link removal",
  },
  "membership-cancellation-submitted": {
    triggerSummary: "Membership cancellation request submitted",
    frequency: "Per requester submission",
  },
  "admin-membership-cancellation-request": {
    triggerSummary: "Membership cancellation ready for admin review",
    frequency: "Per request when at least one participant is reviewable",
  },
  "admin-member-archive-requested": {
    triggerSummary: "Member archive request submitted",
    frequency: "Per archive request",
  },
  "member-archive-approved": {
    triggerSummary: "Member archive request approved",
    frequency: "Per archive approval",
  },
  "member-archive-rejected": {
    triggerSummary: "Member archive request rejected",
    frequency: "Per archive rejection",
  },
  "admin-member-delete-requested": {
    triggerSummary: "Member hard-delete request submitted",
    frequency: "Per delete request",
  },
  "admin-account-deletion-requested": {
    triggerSummary: "Self-service account deletion request submitted",
    frequency: "Per member deletion request",
  },
  "admin-member-delete-approved": {
    triggerSummary: "Member hard-delete request approved",
    frequency: "Per delete approval",
  },
  "admin-member-delete-rejected": {
    triggerSummary: "Member hard-delete request rejected",
    frequency: "Per delete rejection",
  },
  "bulk-communication": {
    triggerSummary: "Admin bulk communication send",
    frequency: "Per admin send action",
  },
  "website-contact": {
    triggerSummary: "Website contact form submission",
    frequency: "Per contact form submission",
  },
  "pre-arrival-reminder": {
    triggerSummary: "Pre-arrival reminder with current lodge access details",
    frequency: "Once per confirmed or paid booking in the reminder window",
  },
  "booking-request-verification": {
    triggerSummary: "Public booking request submitted",
    frequency: "Per booking request submission (and resend requests)",
  },
  "booking-request-approved": {
    triggerSummary: "Public booking request approved and priced by admin",
    frequency: "Per booking request approval",
  },
  "booking-request-quote": {
    triggerSummary: "Public booking request quote sent by admin",
    frequency: "Per booking request quote version sent",
  },
  "booking-request-declined": {
    triggerSummary: "Public booking request declined by admin",
    frequency: "Per booking request decline",
  },
  "admin-booking-request-pending": {
    triggerSummary: "Public booking request verified and ready for pricing",
    frequency: "Per verified booking request",
  },
  "admin-booking-request-hold-expired": {
    triggerSummary: "Request-origin booking unpaid at hold expiry",
    frequency: "Per hold-expiry check on an unpaid request booking",
  },
  "admin-split-settlement-unpaid": {
    triggerSummary:
      "Split booking's non-member guest portion reached its hold deadline with no card on file (member paid their own place by internet banking, or their own place is also unpaid)",
    frequency:
      "Once per hold extension while the guest portion stays unpaid (roughly every two days, matching the request-origin hold-expired cadence)",
  },
  "split-guest-payment-link": {
    triggerSummary:
      "Split booking's guest portion needs settling with no saved card, so the member is emailed a secure /pay/<token> link",
    frequency:
      "Once per fresh payment-link mint (idempotent across cron re-runs); also on the on-demand booking-detail issue action",
  },
  "booking-review-approved": {
    triggerSummary:
      "Admin approved a booking held for minors review, releasing it for payment",
    frequency:
      "Once per approval decision, to the owner, unless the admin opts out of notifying (#1790)",
  },
  "booking-review-rejected": {
    triggerSummary:
      "Admin declined a booking held for minors review; the booking is cancelled",
    frequency:
      "Once per rejection decision, to the owner (suppressible #1790; the always-notify cancellation email still sends)",
  },
  "induction-sign-off-request": {
    triggerSummary:
      "Induction sign-off signer assigned (admin assignment or membership-application approval)",
    frequency: "One email per assigned signer who has an email address",
  },
  "school-attendee-confirmation": {
    triggerSummary:
      "School contact prompted to confirm placeholder attendees (cron sweep or admin resend)",
    frequency:
      "Per send to the school contact; flagged a reminder after the first, token rotated each send",
  },
  "admin-school-manual-invoice": {
    triggerSummary:
      "Approved school booking-request converted while the Xero module is off, so no invoice was raised",
    frequency:
      "Once per conversion, to admins opted into public booking-request alerts",
  },
  "group-booking-join-verification": {
    triggerSummary:
      "Non-member used a join code to claim a group-booking spot and must confirm their email",
    frequency: "One email per join attempt; link expires after 48 hours",
  },
  "group-settlement-receipt": {
    triggerSummary: "Organiser-pays combined group payment settled successfully",
    frequency: "One receipt to the organiser per settlement",
  },
  "group-join-settled": {
    triggerSummary:
      "Organiser settled a joiner's spot as part of a combined group payment",
    frequency: "One email per joiner booking covered by the settled payment",
  },
  "group-settlement-expired": {
    triggerSummary:
      "Organiser's started combined group payment expired before completion; held beds released",
    frequency: "One email to the organiser per expired settlement",
  },
  "group-join-released": {
    triggerSummary:
      "A joiner's held bed was released when the organiser's combined payment expired",
    frequency: "One email per joiner whose held bed was released",
  },
  "group-join-cancelled": {
    triggerSummary:
      "Reaped organiser-pays place was never retried, so the joiner's pending booking was cancelled (#1094)",
    frequency: "One email per cancelled joiner booking",
  },
};

function titleCaseTemplateKey(key: string): string {
  return key
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function audienceForTemplate(key: EmailAuditTemplateName): EmailTemplateAudience {
  if (key === "admin-email-failure") return "system";
  if (ADMIN_SYSTEM_TEMPLATE_NAMES.has(key)) return "admin";
  return "member";
}

function extractTokensFromDefaults(...values: string[]): string[] {
  return values.flatMap((value) =>
    Array.from(value.matchAll(/\{\{([^{}]+)\}\}/g), (match) =>
      match[1].trim(),
    ).filter(Boolean),
  );
}

function uniqueSortedTokens(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function sampleValue(token: string): string {
  if (token === "BASE_URL") return "https://bookings.example.org";
  if (token === "CLUB_NAME") return "Example Mountain Club";
  if (token === "CLUB_BOOKINGS_NAME") return "Example Mountain Club - Bookings";
  if (token === "CLUB_LODGE_NAME") return "Example Mountain Club Lodge";
  if (token === "CLUB_EMAIL_FROM_NAME") {
    return "Example Mountain Club - Online Booking System";
  }
  if (token === "CLUB_LODGE_TRAVEL_NOTE") {
    return "Please allow adequate travel time.";
  }
  if (token === "SUPPORT_EMAIL" || token === "CONTACT_EMAIL") {
    return "support@example.org";
  }
  if (token === "LODGE_CAPACITY") return String(FALLBACK_LODGE_CAPACITY);
  if (token === "doorCode") return "1234";
  if (token === "expectedArrivalTime") return "16:30";
  if (token.endsWith("Email") || token === "email") return "member@example.org";
  if (token.endsWith("Url") || token.endsWith("URL")) {
    return "https://bookings.example.org/admin";
  }
  if (token.toLowerCase().includes("amount") || token.includes("total")) {
    return "$123.45";
  }
  if (token.toLowerCase().includes("count")) return "2";
  if (token.toLowerCase().includes("date") || token.endsWith("At")) {
    return "1 July 2026";
  }
  if (token === "s") return "s";
  if (token === "token") return "sample-token";
  if (token === "recipientName") return "Sam Parent";
  if (token === "lodgeName") return "Example Mountain Club Lodge";
  if (token === "targetAgeTier") return "ADULT";
  if (token === "targetAgeTierLabel") return "Adult (18+)";
  if (token === "targetAgeTierMinAge") return "18";
  return token.replace(/[|]/g, " ");
}

export const EMAIL_TEMPLATE_DEFINITIONS: EmailTemplateDefinition[] = (
  Object.entries(EMAIL_AUDIT_DEFAULTS) as Array<
    [
      EmailAuditTemplateName,
      { defaultSubject: string; defaultBody: string },
    ]
  >
).map(([key, defaults]) => {
  const allowedTokens = uniqueSortedTokens([
    ...GLOBAL_EMAIL_TEMPLATE_TOKENS,
    ...extractTokensFromDefaults(defaults.defaultSubject, defaults.defaultBody),
    ...(EXTRA_TEMPLATE_TOKENS[key] ?? []),
  ]);
  const metadata = TEMPLATE_TRIGGER_METADATA[key] ?? {
    triggerSummary: "Audited application email",
    frequency: "Per trigger",
  };

  return {
    key,
    label: titleCaseTemplateKey(key),
    audience: audienceForTemplate(key),
    defaultSubject: defaults.defaultSubject,
    defaultBody: defaults.defaultBody,
    allowedTokens,
    requiredTokens: REQUIRED_TEMPLATE_TOKENS[key] ?? [],
    sampleData: Object.fromEntries(
      allowedTokens.map((token) => [token, sampleValue(token)]),
    ),
    triggerSummary: metadata.triggerSummary,
    frequency: metadata.frequency,
    deliveryEditable:
      ADMIN_SYSTEM_TEMPLATE_NAMES.has(key) &&
      !LOCKED_DELIVERY_TEMPLATE_NAMES.has(key),
    defaultDeliveryMode: CONTENT_ONLY_DEFAULT_TEMPLATE_NAMES.has(key)
      ? "content_only"
      : "always",
  };
});

const EMAIL_TEMPLATE_KEYS = EMAIL_TEMPLATE_DEFINITIONS.map(
  (definition) => definition.key,
);

export const EMAIL_TEMPLATE_KEY_SET = new Set<string>(EMAIL_TEMPLATE_KEYS);

const APPROVED_EMAIL_TEMPLATE_TOKENS = [
  "BASE_URL",
  "CLUB_BOOKINGS_NAME",
  "CLUB_EMAIL_FROM_NAME",
  "CLUB_LODGE_NAME",
  "CLUB_LODGE_TRAVEL_NOTE",
  "CLUB_NAME",
  "CONTACT_EMAIL",
  "LODGE_CAPACITY",
  "SUPPORT_EMAIL",
  "additionalAmount",
  "additionalPaymentMethod",
  "adminEnteredBody",
  "adminEnteredSubject",
  "adminNote",
  "adminNotes",
  "amount",
  "applicantEmail",
  "applicantName",
  "attemptCount",
  "availableBeds",
  "bookingId",
  "bookingReference",
  "bumpedMemberName",
  "changeFee",
  "checkIn",
  "checkOut",
  "childName",
  "confirmationUrl",
  "choreDescription",
  "choreLink",
  "choreName",
  "contactEmail",
  "correlationKey",
  "count",
  "creditRestored",
  "creditRestoredMessage",
  "creditUsed",
  "date",
  "deadline",
  "description",
  "details",
  "discount",
  "doorCode",
  "email",
  "endDate",
  "entityType",
  "errorMessage",
  "errorType",
  "expectedArrivalTime",
  "expiresAt",
  "expiryLabel",
  "failureCount",
  "familyMemberCount",
  "firstName",
  "formattedDate",
  "generatedAt",
  "groupName",
  "guestCount",
  "guestFirstName",
  "guestLastName",
  "guestName",
  "holdUntil",
  "hoursRemaining",
  "inducteeName",
  "inductionUrl",
  "intendedMemberId",
  "intendedMemberName",
  "inviteeName",
  "inviterName",
  "issueCategoryCount",
  "issueReportUrl",
  "issueTotalCount",
  "joinerCount",
  "latestErrorMessage",
  "localId",
  "localModel",
  "lookbackHours",
  "memberEmail",
  "memberName",
  "message",
  "modificationTypeLabel",
  "name",
  "newCheckIn",
  "newCheckOut",
  "newEmail",
  "newGuestCount",
  "newTotal",
  "nominatorName",
  "occupiedBeds",
  "oldCheckIn",
  "oldCheckOut",
  "oldGuestCount",
  "oldTotal",
  "operation",
  "operationType",
  "organiserName",
  "originalRecipient",
  "originalTemplateName",
  "pageTitle",
  "pageUrl",
  "paidAmount",
  "parentName",
  "partnerName",
  "payUrl",
  "paymentIntentId",
  "paymentReference",
  "paymentNote",
  "price",
  "percent",
  "participantName",
  "participantSummary",
  "pin",
  "position",
  "promoCode",
  "provisionalGuestsNote",
  "quoteOptions",
  "reason",
  "recipientLabel",
  "refundAmount",
  "refundMessage",
  "refundedAmount",
  "remainingAmount",
  "remainingCredit",
  "recipientName",
  "profileUrl",
  "requestId",
  "requestType",
  "requestedSummary",
  "requestedAmount",
  "requesterName",
  "rejoinProcessText",
  "resetUrl",
  "reviewNote",
  "reviewReason",
  "reviewUrl",
  "localUrl",
  "s",
  "schoolName",
  "severityLabel",
  "signerName",
  "signerRoleLabel",
  "stalePendingMinutes",
  "startDate",
  "status",
  "substituteMemberId",
  "substituteMemberName",
  "subtotal",
  "targetAgeTier",
  "targetAgeTierLabel",
  "targetAgeTierMinAge",
  "timestamp",
  "token",
  "total",
  "totalAlerts",
  "totalPaid",
  "triggeringMemberName",
  "verifyUrl",
  "windowHours",
  "xeroObjectUrl",
  "xeroInvoiceNumber",
  "y|ies",
] as const;

export const APPROVED_EMAIL_TEMPLATE_TOKEN_SET = new Set<string>(
  APPROVED_EMAIL_TEMPLATE_TOKENS,
);

// Tokens whose rendered values must never appear in an email subject line.
// Subjects are persisted in EmailLog for every template (including the
// sensitive ones whose HTML bodies are deliberately not retained) and travel
// in clear mail headers, so secret values are restricted to message bodies.
const SENSITIVE_EMAIL_SUBJECT_TOKENS = [
  "choreLink",
  "claimUrl",
  "confirmUrl",
  "confirmationUrl",
  "doorCode",
  "payUrl",
  "pin",
  "resetUrl",
  "respondUrl",
  "token",
  "verifyUrl",
] as const;

export const SENSITIVE_EMAIL_SUBJECT_TOKEN_SET = new Set<string>(
  SENSITIVE_EMAIL_SUBJECT_TOKENS,
);

const TEMPLATE_SENSITIVE_EMAIL_SUBJECT_TOKENS: Partial<
  Record<EmailAuditTemplateName, readonly string[]>
> = {
  // Most reviewUrl values are authenticated admin/profile navigation. This
  // one is the nomination's public bearer link, so scope the restriction to
  // its template instead of disabling harmless review URLs globally.
  "nomination-request": ["reviewUrl"],
};

export function getSensitiveEmailSubjectTokens(
  templateName?: string,
): ReadonlySet<string> {
  return new Set([
    ...SENSITIVE_EMAIL_SUBJECT_TOKEN_SET,
    ...(TEMPLATE_SENSITIVE_EMAIL_SUBJECT_TOKENS[
      templateName as EmailAuditTemplateName
    ] ?? []),
  ]);
}

export function getEmailTemplateDefinition(templateName: string) {
  return EMAIL_TEMPLATE_DEFINITIONS.find(
    (definition) => definition.key === templateName,
  );
}

export function isAdminSystemTemplate(templateName: string): boolean {
  return ADMIN_SYSTEM_TEMPLATE_NAMES.has(templateName as EmailAuditTemplateName);
}

export function getDefaultDeliveryMode(
  templateName: string,
): NotificationDeliveryModeValue {
  return getEmailTemplateDefinition(templateName)?.defaultDeliveryMode ?? "always";
}
