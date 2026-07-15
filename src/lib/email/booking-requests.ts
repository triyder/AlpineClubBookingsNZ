import {
  bookingRequestVerificationTemplate,
  bookingRequestApprovedTemplate,
  bookingRequestQuoteTemplate,
  bookingRequestDeclinedTemplate,
  schoolAttendeeConfirmationTemplate,
} from "../email-templates";
import { CLUB_NAME } from "@/config/club-identity";
import {
  formatNZDate,
  formatNZDateTime,
} from "../nzst-date";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendEmail, type EmailSendOutcome } from "./core";

// ---- Public booking request flow (issue #707) ----

export async function sendBookingRequestVerificationEmail(params: {
  email: string;
  firstName: string;
  token: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expiresAt: Date;
  // Lodge the request is for (multi-lodge): overlays that lodge's
  // identity via prepareEmailMessage; null keeps club-wide identity.
  lodgeId?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/booking-requests/verify/${params.token}`;

  await sendEmail({
    to: params.email,
    lodgeId: params.lodgeId,
    subject: `Confirm your booking request — ${CLUB_NAME}`,
    html: bookingRequestVerificationTemplate({
      firstName: params.firstName,
      verifyUrl,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
      expiresAt: params.expiresAt,
    }),
    templateName: "booking-request-verification",
    templateData: {
      firstName: params.firstName,
      token: params.token,
      verifyUrl,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      guestCount: params.guestCount,
      expiresAt: formatNZDateTime(params.expiresAt),
    },
  });
}

export async function sendBookingRequestApprovedEmail(params: {
  email: string;
  firstName: string;
  token: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  priceCents: number;
  bookingReference: string;
  expiresAt: Date;
  // Lodge the request is for (multi-lodge): overlays that lodge's
  // identity via prepareEmailMessage; null keeps club-wide identity.
  lodgeId?: string | null;
}): Promise<EmailSendOutcome> {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const payUrl = `${baseUrl}/pay/${params.token}`;

  // Return the send outcome so callers can tell a delivered email from a
  // suppressed one (F25, #1885) instead of assuming the mail went out.
  return sendEmail({
    to: params.email,
    lodgeId: params.lodgeId,
    subject: `Your booking request has been approved — ${CLUB_NAME}`,
    html: bookingRequestApprovedTemplate({
      firstName: params.firstName,
      payUrl,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
      priceCents: params.priceCents,
      expiresAt: params.expiresAt,
    }),
    templateName: "booking-request-approved",
    templateData: {
      firstName: params.firstName,
      token: params.token,
      payUrl,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      guestCount: params.guestCount,
      priceCents: params.priceCents,
      price: formatMoneyCents(params.priceCents),
      bookingReference: params.bookingReference,
      expiresAt: formatNZDateTime(params.expiresAt),
    },
  });
}

export async function sendBookingRequestQuoteEmail(params: {
  email: string;
  firstName: string;
  token: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  requestType: string;
  schoolName?: string | null;
  options: Array<{ label: string; totalCents: number }>;
  message?: string | null;
  expiresAt: Date;
  isReminder?: boolean;
  // Lodge the request is for (multi-lodge): overlays that lodge's
  // identity via prepareEmailMessage; null keeps club-wide identity.
  lodgeId?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const respondUrl = `${baseUrl}/booking-requests/respond/${params.token}`;

  await sendEmail({
    to: params.email,
    lodgeId: params.lodgeId,
    subject: params.isReminder
      ? `Reminder: your booking quote expires soon — ${CLUB_NAME}`
      : `Your booking quote is ready — ${CLUB_NAME}`,
    html: bookingRequestQuoteTemplate({
      firstName: params.firstName,
      respondUrl,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
      options: params.options,
      message: params.message,
      expiresAt: params.expiresAt,
      schoolName: params.schoolName,
      isReminder: params.isReminder,
    }),
    templateName: "booking-request-quote",
    templateData: {
      firstName: params.firstName,
      token: params.token,
      respondUrl,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      guestCount: params.guestCount,
      requestType: params.requestType,
      schoolName: params.schoolName ?? "",
      quoteOptions: params.options
        .map((option) => `${option.label}: ${formatMoneyCents(option.totalCents)}`)
        .join("\n"),
      expiresAt: formatNZDateTime(params.expiresAt),
    },
  });
}

export async function sendBookingRequestDeclinedEmail(params: {
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  reason?: string | null;
  // Lodge the request is for (multi-lodge): overlays that lodge's
  // identity via prepareEmailMessage; null keeps club-wide identity.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    lodgeId: params.lodgeId,
    subject: `Update on your booking request — ${CLUB_NAME}`,
    html: bookingRequestDeclinedTemplate({
      firstName: params.firstName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      reason: params.reason,
    }),
    templateName: "booking-request-declined",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      reason: params.reason ?? "",
    },
  });
}

/**
 * School attendee confirmation prompt (#1101): tokenized link, rotated on
 * every send, where the school contact renames placeholder attendees and
 * confirms the list before check-in.
 */
export async function sendSchoolAttendeeConfirmationEmail(params: {
  email: string;
  firstName: string;
  schoolName: string | null;
  token: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  isReminder: boolean;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const confirmUrl = `${baseUrl}/school-bookings/confirm/${params.token}`;

  await sendEmail({
    to: params.email,
    subject: params.isReminder
      ? `Reminder: confirm your attendee list — ${CLUB_NAME}`
      : `Confirm your attendee list — ${CLUB_NAME}`,
    html: schoolAttendeeConfirmationTemplate({
      firstName: params.firstName,
      schoolName: params.schoolName,
      confirmUrl,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
      isReminder: params.isReminder,
    }),
    templateName: "school-attendee-confirmation",
    templateData: {
      firstName: params.firstName,
      // Registered defaultBody references {{token}} for the confirm link, so an
      // admin override can render it (the hardcoded sender builds the link in HTML).
      token: params.token,
      schoolName: params.schoolName ?? "",
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      guestCount: params.guestCount,
      isReminder: params.isReminder,
    },
  });
}
