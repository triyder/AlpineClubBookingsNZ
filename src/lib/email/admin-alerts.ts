import {
  adminMembershipApplicationPendingTemplate,
  adminNewBookingTemplate,
  adminPaymentFailureTemplate,
  adminPendingDeadlineTemplate,
  adminBookingBumpedTemplate,
  adminXeroSyncErrorTemplate,
  adminXeroRepeatedFailureTemplate,
  adminCapacityWarningTemplate,
  adminDailyDigestTemplate,
  adminXeroReconciliationReportTemplate,
  adminWaitlistOfferTemplate,
  adminFamilyGroupRequestTemplate,
  adminMembershipCancellationRequestTemplate,
  adminMemberArchiveRequestedTemplate,
  adminMemberDeleteRequestedTemplate,
  adminMemberDeleteApprovedTemplate,
  adminMemberDeleteRejectedTemplate,
  adminRefundRequestTemplate,
  adminBookingChangeRequestTemplate,
  adminIssueReportTemplate,
  adminBookingRequestPendingTemplate,
  adminSchoolManualInvoiceTemplate,
  adminBookingRequestHoldExpiredTemplate,
  type XeroReconciliationReportEmail,
} from "../email-templates";
import { CLUB_BOOKINGS_NAME } from "@/config/club-identity";
import {
  ADMIN_NOTIFICATION_PREFERENCE_SELECT,
  type AdminNotificationPreferenceKey,
  resolveAdminNotificationPreferences,
} from "../admin-notification-preferences";
import {
  formatNZDate,
  formatNZDateTime,
} from "../nzst-date";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { buildBookingRequestsHref } from "@/lib/admin-booking-requests-path";
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
async function sendToAdmins({
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

        return { status: outcome.status };
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

async function shouldSendDirectAdminSystemEmail(templateName: string) {
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

export async function sendAdminMembershipApplicationPendingEmail(data: {
  applicationId: string;
  applicantName: string;
  applicantEmail: string;
  familyMemberCount: number;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/member-applications`;

  await sendToAdmins({
    subject: `Membership application ready: ${data.applicantName}`,
    html: adminMembershipApplicationPendingTemplate({
      applicantName: data.applicantName,
      applicantEmail: data.applicantEmail,
      familyMemberCount: data.familyMemberCount,
      reviewUrl,
    }),
    templateName: "admin-membership-application-pending",
    templateData: {
      applicantName: data.applicantName,
      applicantEmail: data.applicantEmail,
      familyMemberCount: data.familyMemberCount,
      reviewUrl,
    },
    // Shared request-alert category: membership applications + family-group requests.
    preferenceKey: "adminFamilyGroupRequest",
  });
}

// N-02: Admin alert - new booking
export async function sendAdminNewBookingAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  status: string;
  reviewReason?: string | null;
  memberJustification?: string | null;
}) {
  await sendToAdmins({
    subject: data.reviewReason
      ? `Booking Review Required: ${data.memberName}`
      : `New Booking: ${data.memberName} (${data.status})`,
    html: adminNewBookingTemplate(data),
    templateName: "admin-new-booking",
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      total: formatMoneyCents(data.totalCents),
      reviewReason: data.reviewReason ?? "",
      memberJustification: data.memberJustification ?? "",
    },
    preferenceKey: "adminNewBooking",
  });
}

// N-04: Admin alert - payment failure
export async function sendAdminPaymentFailureAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  errorMessage: string;
  paymentIntentId: string;
}) {
  await sendToAdmins({
    subject: `Payment Failed — ${CLUB_BOOKINGS_NAME}`,
    html: adminPaymentFailureTemplate(data),
    templateName: "admin-payment-failure",
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      amount: formatMoneyCents(data.amountCents),
    },
    preferenceKey: "adminPaymentFailure",
  });
}

// N-06: Admin alert - pending approaching deadline (digest)
export async function sendAdminPendingDeadlineAlert(
  bookings: Array<{
    memberName: string;
    checkIn: Date;
    checkOut: Date;
    guestCount: number;
    deadline: Date;
    hoursRemaining: number;
  }>,
) {
  await sendToAdmins({
    subject: `${bookings.length} Pending Booking${bookings.length > 1 ? "s" : ""} Approaching Deadline`,
    html: adminPendingDeadlineTemplate(bookings),
    templateName: "admin-pending-deadline",
    templateData: {
      count: bookings.length,
      s: bookings.length === 1 ? "" : "s",
      memberName: bookings.map((booking) => booking.memberName).join(", "),
      checkIn: bookings
        .map((booking) => formatNZDate(booking.checkIn))
        .join(", "),
      checkOut: bookings
        .map((booking) => formatNZDate(booking.checkOut))
        .join(", "),
      guestCount: bookings.map((booking) => booking.guestCount).join(", "),
      deadline: bookings
        .map((booking) => formatNZDateTime(booking.deadline))
        .join(", "),
      hoursRemaining: bookings
        .map((booking) => Math.round(booking.hoursRemaining))
        .join(", "),
    },
    preferenceKey: "adminPendingDeadline",
  });
}

// N-07: Admin alert - booking bumped
export async function sendAdminBookingBumpedAlert(data: {
  bumpedMemberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  triggeringMemberName: string;
}) {
  await sendToAdmins({
    subject: `Booking Bumped: ${data.bumpedMemberName}`,
    html: adminBookingBumpedTemplate(data),
    templateName: "admin-booking-bumped",
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
    },
    preferenceKey: "adminBookingBumped",
  });
}

// N-05: Admin alert - Xero sync error
export async function sendAdminXeroSyncErrorAlert(data: {
  errorType: string;
  operation: string;
  errorMessage: string;
  timestamp: Date;
}) {
  await sendToAdmins({
    subject: `Xero Sync Error — ${CLUB_BOOKINGS_NAME}`,
    html: adminXeroSyncErrorTemplate(data),
    templateName: "admin-xero-sync-error",
    templateData: {
      ...data,
      timestamp: data.timestamp.toISOString(),
    },
    preferenceKey: "adminXeroSyncError",
  });
}

export async function sendAdminXeroRepeatedFailureAlert(data: {
  subject: string;
  correlationKey: string;
  failureCount: number;
  windowHours: number;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectUrl: string | null;
  latestErrorMessage: string | null;
  timestamp: Date;
}) {
  await sendToAdmins({
    subject: data.subject,
    html: adminXeroRepeatedFailureTemplate(data),
    templateName: "admin-xero-repeated-failure",
    templateData: {
      ...data,
      localModel: data.localModel ?? "",
      localId: data.localId ?? "",
      latestErrorMessage: data.latestErrorMessage ?? "",
      timestamp: data.timestamp.toISOString(),
    },
    preferenceKey: "adminXeroSyncError",
  });
}

// N-03: Admin alert - capacity warning
export async function sendAdminCapacityWarningAlert(
  days: Array<{
    date: Date;
    occupiedBeds: number;
    availableBeds: number;
  }>,
  lodgeCapacity: number,
) {
  await sendToAdmins({
    subject: `Capacity Warning: ${days.length} high-occupancy day${days.length > 1 ? "s" : ""} ahead`,
    html: adminCapacityWarningTemplate(days, lodgeCapacity),
    templateName: "admin-capacity-warning",
    templateData: {
      count: days.length,
      s: days.length === 1 ? "" : "s",
      date: days.map((day) => formatNZDate(day.date)).join(", "),
      occupiedBeds: days.map((day) => day.occupiedBeds).join(", "),
      availableBeds: days.map((day) => day.availableBeds).join(", "),
      percent: days
        .map((day) =>
          lodgeCapacity > 0
            ? String(Math.round((day.occupiedBeds / lodgeCapacity) * 100))
            : "0",
        )
        .join(", "),
    },
    preferenceKey: "adminCapacityWarning",
  });
}

// N-13: Admin daily digest
export async function sendAdminDailyDigestAlert(sections: {
  newBookings: number;
  paymentFailures: number;
  capacityWarnings: number;
  bookingsBumped: number;
  pendingDeadlines: number;
  xeroErrors: number;
  totalAlerts: number;
}) {
  await sendToAdmins({
    subject: `Admin Daily Digest - ${sections.totalAlerts} alert${sections.totalAlerts !== 1 ? "s" : ""} in past 24h`,
    html: adminDailyDigestTemplate(sections),
    templateName: "admin-daily-digest",
    templateData: {
      ...sections,
      count: sections.totalAlerts,
      s: sections.totalAlerts === 1 ? "" : "s",
    },
    preferenceKey: "adminDailyDigest",
  });
}

export async function sendAdminXeroReconciliationReportAlert(
  report: XeroReconciliationReportEmail,
) {
  const subject =
    report.summary.issueCategoryCount === 0
      ? "Xero Reconciliation Report - clean"
      : `Xero Reconciliation Report - action needed: ${report.summary.issueCategoryCount} categor${report.summary.issueCategoryCount === 1 ? "y" : "ies"}, ${report.summary.issueTotalCount} item${report.summary.issueTotalCount === 1 ? "" : "s"}`;

  await sendToAdmins({
    subject,
    html: adminXeroReconciliationReportTemplate(report),
    templateName: "admin-xero-reconciliation-report",
    templateData: {
      generatedAt: report.generatedAt.toISOString(),
      lookbackHours: report.lookbackHours,
      stalePendingMinutes: report.stalePendingMinutes,
      issueCategoryCount: report.summary.issueCategoryCount,
      issueTotalCount: report.summary.issueTotalCount,
      count: report.summary.issueTotalCount,
    },
    preferenceKey: "adminXeroSyncError",
  });
}

// Shared request-alert category for family-group requests and membership applications.
export async function sendAdminFamilyGroupRequestAlert(data: {
  requestType: string;
  requesterName: string;
  groupName: string;
  details: string;
}) {
  await sendToAdmins({
    subject: `Family Group Request: ${data.requesterName} (${data.requestType})`,
    html: adminFamilyGroupRequestTemplate(data),
    templateName: "admin-family-group-request",
    templateData: data,
    preferenceKey: "adminFamilyGroupRequest",
  });
}

export async function sendAdminMembershipCancellationRequestAlert(params: {
  requesterName: string;
  participantSummary: string;
  reason?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/membership-cancellations`;

  await sendToAdmins({
    subject: `Membership cancellation ready: ${params.requesterName}`,
    html: adminMembershipCancellationRequestTemplate({
      requesterName: params.requesterName,
      participantSummary: params.participantSummary,
      reason: params.reason,
      reviewUrl,
    }),
    templateName: "admin-membership-cancellation-request",
    templateData: {
      requesterName: params.requesterName,
      participantSummary: params.participantSummary,
      reason: params.reason ?? "",
      reviewUrl,
    },
    preferenceKey: "adminFamilyGroupRequest",
  });
}

export async function sendAdminMemberArchiveRequestedAlert(params: {
  requesterName: string;
  memberId: string;
  memberName: string;
  reason: string;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/membership-cancellations`;

  await sendToAdmins({
    subject: `Member archive requested: ${params.memberName}`,
    html: adminMemberArchiveRequestedTemplate({
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    }),
    templateName: "admin-member-archive-requested",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    },
    preferenceKey: "adminFamilyGroupRequest",
  });
}

export async function sendAdminMemberDeleteRequestedAlert(params: {
  requesterName: string;
  memberId: string;
  memberName: string;
  reason: string;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/members/${encodeURIComponent(params.memberId)}`;

  await sendToAdmins({
    subject: `Member delete requested: ${params.memberName}`,
    html: adminMemberDeleteRequestedTemplate({
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    }),
    templateName: "admin-member-delete-requested",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    },
    preferenceKey: "adminFamilyGroupRequest",
  });
}

export async function sendAdminMemberDeleteApprovedEmail(params: {
  email: string;
  requesterName: string;
  memberName: string;
  reason: string;
  reviewNote?: string | null;
}) {
  if (
    !(await shouldSendDirectAdminSystemEmail("admin-member-delete-approved"))
  ) {
    return;
  }

  await sendEmail({
    to: params.email,
    subject: `Member delete approved: ${params.memberName}`,
    html: adminMemberDeleteApprovedTemplate(params),
    templateName: "admin-member-delete-approved",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewNote: params.reviewNote ?? "",
    },
  });
}

export async function sendAdminMemberDeleteRejectedEmail(params: {
  email: string;
  requesterName: string;
  memberId: string;
  memberName: string;
  reason: string;
  reviewNote?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/members/${encodeURIComponent(params.memberId)}`;

  if (
    !(await shouldSendDirectAdminSystemEmail("admin-member-delete-rejected"))
  ) {
    return;
  }

  await sendEmail({
    to: params.email,
    subject: `Member delete rejected: ${params.memberName}`,
    html: adminMemberDeleteRejectedTemplate({
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewNote: params.reviewNote,
      reviewUrl,
    }),
    templateName: "admin-member-delete-rejected",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewNote: params.reviewNote ?? "",
      reviewUrl,
    },
  });
}

export async function sendAdminWaitlistOfferAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  position: number;
}) {
  await sendToAdmins({
    subject: `Waitlist Offer: ${data.memberName}`,
    html: adminWaitlistOfferTemplate(data),
    templateName: "admin-waitlist-offer",
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
    },
    preferenceKey: "adminWaitlistOffer",
  });
}

export async function sendAdminRefundRequestAlert(data: {
  memberName: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  reason: string;
  requestedAmountCents: number | null;
  paidAmountCents: number;
  refundedAmountCents: number;
}) {
  await sendToAdmins({
    subject: `Refund Appeal: ${data.memberName}`,
    html: adminRefundRequestTemplate(data),
    templateName: "admin-refund-request",
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      paidAmount: formatMoneyCents(data.paidAmountCents),
      refundedAmount: formatMoneyCents(data.refundedAmountCents),
      remainingAmount: formatMoneyCents(
        data.paidAmountCents - data.refundedAmountCents,
      ),
      requestedAmount:
        data.requestedAmountCents === null
          ? ""
          : formatMoneyCents(data.requestedAmountCents),
    },
    preferenceKey: "adminRefundRequest",
  });
}

export async function sendAdminBookingChangeRequestAlert(data: {
  memberName: string;
  memberEmail: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  requestedSummary: string;
  reason: string | null;
  requestId: string;
}) {
  const reviewUrl = `${process.env.NEXTAUTH_URL || "http://localhost:3000"}${buildBookingRequestsHref(
    "changes",
    { requestId: data.requestId },
  )}`;

  await sendToAdmins({
    subject: `Booking Change Request: ${data.memberName}`,
    html: adminBookingChangeRequestTemplate({
      memberName: data.memberName,
      memberEmail: data.memberEmail,
      bookingId: data.bookingId,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      requestedSummary: data.requestedSummary,
      reason: data.reason,
      reviewUrl,
    }),
    templateName: "admin-booking-change-request",
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      reason: data.reason ?? "",
      reviewUrl,
    },
    preferenceKey: "adminBookingChangeRequest",
  });
}

export async function sendAdminIssueReportAlert(data: {
  memberName: string;
  memberEmail: string;
  pageUrl: string;
  pageTitle?: string | null;
  description: string;
  issueReportUrl: string;
  hasScreenshot: boolean;
}) {
  await sendToAdmins({
    subject: `Issue Report: ${data.memberName}`,
    html: adminIssueReportTemplate({
      memberName: data.memberName,
      memberEmail: data.memberEmail,
      pageUrl: data.pageUrl,
      pageTitle: data.pageTitle,
      description: data.description,
      issueReportUrl: data.issueReportUrl,
      hasScreenshot: data.hasScreenshot,
    }),
    templateName: "admin-issue-report",
    templateData: {
      ...data,
      pageTitle: data.pageTitle ?? data.pageUrl,
    },
    preferenceKey: "adminIssueReport",
  });
}

export async function sendAdminBookingRequestPendingEmail(data: {
  requesterName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${buildBookingRequestsHref("public", {})}`;

  await sendToAdmins({
    subject: `Booking request ready for review: ${data.requesterName}`,
    html: adminBookingRequestPendingTemplate({
      requesterName: data.requesterName,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      guestCount: data.guestCount,
      reviewUrl,
    }),
    templateName: "admin-booking-request-pending",
    templateData: {
      requesterName: data.requesterName,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      guestCount: data.guestCount,
      reviewUrl,
    },
    preferenceKey: "adminBookingRequest",
  });
}

export async function sendAdminSchoolManualInvoiceEmail(data: {
  schoolName: string;
  contactEmail: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${buildBookingRequestsHref("public", {})}`;

  await sendToAdmins({
    subject: `School booking needs a manual invoice: ${data.schoolName}`,
    html: adminSchoolManualInvoiceTemplate({
      schoolName: data.schoolName,
      contactEmail: data.contactEmail,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      guestCount: data.guestCount,
      totalCents: data.totalCents,
      reviewUrl,
    }),
    templateName: "admin-school-manual-invoice",
    templateData: {
      schoolName: data.schoolName,
      contactEmail: data.contactEmail,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      guestCount: data.guestCount,
      totalCents: data.totalCents,
      amount: formatMoneyCents(data.totalCents),
      reviewUrl,
    },
    preferenceKey: "adminBookingRequest",
  });
}

export async function sendAdminBookingRequestHoldExpiredEmail(data: {
  requesterName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  holdUntil: Date;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/bookings`;

  await sendToAdmins({
    subject: `Request booking unpaid at hold expiry: ${data.requesterName}`,
    html: adminBookingRequestHoldExpiredTemplate({
      requesterName: data.requesterName,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      guestCount: data.guestCount,
      totalCents: data.totalCents,
      holdUntil: data.holdUntil,
      reviewUrl,
    }),
    templateName: "admin-booking-request-hold-expired",
    templateData: {
      requesterName: data.requesterName,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      guestCount: data.guestCount,
      total: formatMoneyCents(data.totalCents),
      holdUntil: formatNZDateTime(data.holdUntil),
      reviewUrl,
    },
    preferenceKey: "adminBookingRequest",
  });
}
