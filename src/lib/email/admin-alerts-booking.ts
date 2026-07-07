import {
  adminMinorsReviewRequiredTemplate,
  adminOwnerSubstitutionTemplate,
  adminNewBookingTemplate,
  adminPendingDeadlineTemplate,
  adminBookingBumpedTemplate,
  adminCapacityWarningTemplate,
  adminWaitlistOfferTemplate,
  adminBookingChangeRequestTemplate,
  adminBookingRequestPendingTemplate,
  adminSchoolManualInvoiceTemplate,
  adminBookingRequestHoldExpiredTemplate,
} from "../email-templates";
import {
  formatNZDate,
  formatNZDateTime,
} from "../nzst-date";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { buildBookingRequestsHref } from "@/lib/admin-booking-requests-path";
import { sendToAdmins } from "./admin-alerts-shared";

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

// F27 / #1372: Admin alert - paid booking edited into a minors-only (no-adult)
// composition. The booking KEEPS its PAID status (Option A) but is blocked from
// lodge check-in until an admin clears the review, so admins need a nudge that a
// silent flag was set. #1422: this fires on its own "Booking review required"
// preference category so muting routine new-booking alerts does not silence a
// review-required alert.
export async function sendAdminMinorsOnlyReviewAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  reviewReason: string;
}) {
  await sendToAdmins({
    subject: `Review required: booking has only under-18 guests (${data.memberName})`,
    html: adminMinorsReviewRequiredTemplate(data),
    templateName: "admin-minors-review",
    templateData: {
      memberName: data.memberName,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      guestCount: data.guestCount,
      reviewReason: data.reviewReason,
    },
    preferenceKey: "adminBookingReviewRequired",
  });
}

// F20 / #1377: Admin alert - a held booking-request owner failed re-validation
// at conversion, so a fresh non-login contact was minted and the invoice will
// bill THAT contact instead of the intended owner. Routed to the Xero-sync-error
// audience (finance/Xero admins) because the remedy is a Xero contact
// reconciliation, reusing the existing `adminXeroSyncError` preference key so a
// rare event needs no new NotificationPreference column.
export async function sendAdminOwnerSubstitutionAlert(data: {
  requestId: string;
  bookingId: string;
  intendedMemberId: string;
  intendedMemberName?: string | null;
  substituteMemberId: string;
  substituteMemberName?: string | null;
  reason: string;
  requesterName: string;
  requesterEmail: string;
  checkIn: Date;
  checkOut: Date;
}) {
  await sendToAdmins({
    subject: `Owner substitution — reconcile Xero contact for booking request ${data.requestId}`,
    html: adminOwnerSubstitutionTemplate(data),
    templateName: "admin-owner-substitution",
    templateData: {
      requestId: data.requestId,
      bookingId: data.bookingId,
      intendedMemberId: data.intendedMemberId,
      intendedMemberName: data.intendedMemberName ?? "",
      substituteMemberId: data.substituteMemberId,
      substituteMemberName: data.substituteMemberName ?? "",
      reason: data.reason,
      requesterName: data.requesterName,
      memberEmail: data.requesterEmail,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
    },
    preferenceKey: "adminXeroSyncError",
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

// test seam
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

// N-03: Admin alert - capacity warning
export async function sendAdminCapacityWarningAlert(
  days: Array<{
    date: Date;
    occupiedBeds: number;
    availableBeds: number;
  }>,
  lodgeCapacity: number,
  // Lodge the warning is about; null for single-lodge clubs (ADR-002),
  // which keeps the pre-multi-lodge subject and body unchanged.
  lodgeName?: string | null,
) {
  await sendToAdmins({
    subject: `Capacity Warning: ${days.length} high-occupancy day${days.length > 1 ? "s" : ""} ahead${lodgeName ? ` at ${lodgeName}` : ""}`,
    html: adminCapacityWarningTemplate(days, lodgeCapacity, lodgeName),
    templateName: "admin-capacity-warning",
    templateData: {
      count: days.length,
      s: days.length === 1 ? "" : "s",
      lodgeName: lodgeName ?? "",
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
