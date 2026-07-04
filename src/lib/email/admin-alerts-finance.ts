import {
  adminPaymentFailureTemplate,
  adminXeroSyncErrorTemplate,
  adminXeroRepeatedFailureTemplate,
  adminXeroReconciliationReportTemplate,
  adminRefundRequestTemplate,
  type XeroReconciliationReportEmail,
} from "../email-templates";
import { CLUB_BOOKINGS_NAME } from "@/config/club-identity";
import { formatNZDate } from "../nzst-date";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendToAdmins } from "./admin-alerts-shared";

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
