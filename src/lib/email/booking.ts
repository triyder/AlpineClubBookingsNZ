import {
  bookingConfirmedTemplate,
  bookingPendingTemplate,
  bookingBumpedTemplate,
  bookingGuestsCancelledTemplate,
  bookingCancelledTemplate,
  bookingReviewApprovedTemplate,
  bookingReviewRejectedTemplate,
  checkinReminderTemplate,
  bookingModifiedTemplate,
  setupIntentFailedTemplate,
  preArrivalReminderTemplate,
} from "../email-templates";
import { CLUB_LODGE_NAME } from "@/config/club-identity";
import {
  formatNZDate,
  formatNZDateTime,
} from "../nzst-date";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { loadEmailMessageSettings } from "@/lib/email-message-settings";
import { sendEmail } from "./core";

export async function sendBookingConfirmedEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  totalCents: number,
  options?: {
    discountCents?: number;
    promoAdjustmentCents?: number;
    promoCode?: string;
  },
) {
  const settings = await loadEmailMessageSettings();
  const promoAdjustmentCents =
    options?.promoAdjustmentCents ??
    (options?.discountCents && options.discountCents > 0
      ? -options.discountCents
      : 0);
  const promoAdjustmentPrefix = promoAdjustmentCents > 0 ? "+" : "-";
  await sendEmail({
    to: email,
    subject: `Booking Confirmed - ${CLUB_LODGE_NAME}`,
    html: bookingConfirmedTemplate(
      firstName,
      checkIn,
      checkOut,
      guestCount,
      totalCents,
      {
        ...options,
        lodgeTravelNote: settings.lodgeTravelNote,
        doorCode: settings.doorCode,
      },
    ),
    templateName: "booking-confirmed",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
      subtotal:
        promoAdjustmentCents !== 0
          ? formatMoneyCents(totalCents - promoAdjustmentCents)
          : "",
      promoCode: options?.promoCode ?? "",
      discount:
        promoAdjustmentCents < 0
          ? formatMoneyCents(Math.abs(promoAdjustmentCents))
          : "",
      promoAdjustment:
        promoAdjustmentCents !== 0
          ? `${promoAdjustmentPrefix}${formatMoneyCents(Math.abs(promoAdjustmentCents))}`
          : "",
      totalPaid: formatMoneyCents(totalCents),
      total: formatMoneyCents(totalCents),
      doorCode: settings.doorCode ?? "",
    },
  });
}

export async function sendBookingPendingEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  holdUntil: Date,
) {
  await sendEmail({
    to: email,
    subject: `Booking Pending - ${CLUB_LODGE_NAME}`,
    html: bookingPendingTemplate(
      firstName,
      checkIn,
      checkOut,
      guestCount,
      holdUntil,
    ),
    templateName: "booking-pending",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
      holdUntil: formatNZDateTime(holdUntil),
    },
  });
}

export async function sendBookingBumpedEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
) {
  await sendEmail({
    to: email,
    subject: `Booking Update - ${CLUB_LODGE_NAME}`,
    html: bookingBumpedTemplate(firstName, checkIn, checkOut, guestCount),
    templateName: "booking-bumped",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
    },
  });
}

export async function sendBookingGuestsCancelledEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
) {
  await sendEmail({
    to: email,
    subject: `Booking Cancelled - ${CLUB_LODGE_NAME}`,
    html: bookingGuestsCancelledTemplate(firstName, checkIn, checkOut),
    templateName: "booking-guests-cancelled",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
    },
  });
}

export async function sendBookingCancelledEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  refundCents: number,
  refundMethod: "card" | "credit" = "card",
  creditRestoredCents: number = 0,
) {
  await sendEmail({
    to: email,
    subject: `Booking Cancelled - ${CLUB_LODGE_NAME}`,
    html: bookingCancelledTemplate(
      firstName,
      checkIn,
      checkOut,
      refundCents,
      refundMethod,
      creditRestoredCents,
    ),
    templateName: "booking-cancelled",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      refundAmount: formatMoneyCents(refundCents),
      refundMessage:
        refundCents > 0 && refundMethod === "credit"
          ? `A credit of ${formatMoneyCents(refundCents)} has been added to your account for future bookings.`
          : refundCents > 0
            ? `A refund of ${formatMoneyCents(refundCents)} has been processed to your original payment method.`
            : "No refund was applicable based on the cancellation policy.",
      // #1164 / D7: applied account credit is restored subject to the same
      // cancellation policy as the card slice. Empty when nothing was restored
      // so the override body renders no line (mirrors the refundMessage token).
      creditRestored: formatMoneyCents(creditRestoredCents),
      creditRestoredMessage:
        creditRestoredCents > 0
          ? `${formatMoneyCents(creditRestoredCents)} of previously applied account credit has been restored to your account (per the cancellation policy).`
          : "",
    },
  });
}

export async function sendBookingReviewApprovedEmail(params: {
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  adminNotes: string;
  bookingId: string;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your booking has been approved - ${CLUB_LODGE_NAME}`,
    html: bookingReviewApprovedTemplate(
      params.firstName,
      params.checkIn,
      params.checkOut,
      params.adminNotes,
      params.bookingId,
    ),
    templateName: "booking-review-approved",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      adminNotes: params.adminNotes,
      bookingId: params.bookingId,
    },
  });
}

export async function sendBookingReviewRejectedEmail(params: {
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  adminNotes: string;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your booking could not be approved - ${CLUB_LODGE_NAME}`,
    html: bookingReviewRejectedTemplate(
      params.firstName,
      params.checkIn,
      params.checkOut,
      params.adminNotes,
    ),
    templateName: "booking-review-rejected",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      adminNotes: params.adminNotes,
    },
  });
}

// N-01: Check-in reminder
export async function sendCheckinReminderEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guests: Array<{ firstName: string; lastName: string }>,
  chores: Array<{ name: string; description: string | null }>,
) {
  await sendEmail({
    to: email,
    subject: `Check-in Reminder - ${CLUB_LODGE_NAME}`,
    html: checkinReminderTemplate(firstName, checkIn, checkOut, guests, chores),
    templateName: "checkin-reminder",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount: guests.length,
      guestFirstName: guests.map((guest) => guest.firstName).join(", "),
      guestLastName: guests.map((guest) => guest.lastName).join(", "),
      choreName: chores.map((chore) => chore.name).join(", "),
      choreDescription: chores
        .map((chore) => chore.description ?? "")
        .filter(Boolean)
        .join(", "),
    },
  });
}

export async function sendPreArrivalReminderEmail(params: {
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expectedArrivalTime?: string | null;
}) {
  const settings = await loadEmailMessageSettings();
  await sendEmail({
    to: params.email,
    subject: `Pre-arrival Information - ${CLUB_LODGE_NAME}`,
    html: preArrivalReminderTemplate({
      ...params,
      lodgeTravelNote: settings.lodgeTravelNote,
      doorCode: settings.doorCode,
    }),
    templateName: "pre-arrival-reminder",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      guestCount: params.guestCount,
      expectedArrivalTime: params.expectedArrivalTime ?? "",
      doorCode: settings.doorCode ?? "",
    },
  });
}

// EML-01: Booking modified email
export async function sendBookingModifiedEmail(params: {
  email: string;
  firstName: string;
  modificationType: string;
  oldCheckIn: Date;
  oldCheckOut: Date;
  newCheckIn: Date;
  newCheckOut: Date;
  oldGuestCount: number;
  newGuestCount: number;
  oldFinalPriceCents: number;
  newFinalPriceCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  accountCreditAmountCents?: number;
  additionalAmountCents: number;
  additionalPaymentMethod?: "STRIPE" | "INTERNET_BANKING";
  paymentReference?: string | null;
  xeroInvoiceNumber?: string | null;
}) {
  const accountCreditAmountCents = params.accountCreditAmountCents ?? 0;
  const xeroInvoicePaymentContext = params.xeroInvoiceNumber
    ? ` Xero invoice ${params.xeroInvoiceNumber} will be used for payment.`
    : " A Xero invoice and payment reference will be used for payment.";
  const paymentReferenceContext = params.paymentReference
    ? ` Payment reference: ${params.paymentReference}.`
    : "";
  const paymentNote =
    params.refundAmountCents > 0
      ? `A refund of ${formatMoneyCents(params.refundAmountCents)} has been processed to your original payment method.`
      : accountCreditAmountCents > 0
        ? `Account credit of ${formatMoneyCents(accountCreditAmountCents)} has been added for future bookings.`
        : params.additionalAmountCents > 0
          ? params.additionalPaymentMethod === "INTERNET_BANKING"
            ? `An additional Internet Banking payment of ${formatMoneyCents(params.additionalAmountCents)} is required.${xeroInvoicePaymentContext}${paymentReferenceContext} Xero reconciliation confirms the payment before it is treated as paid.`
            : `An additional payment of ${formatMoneyCents(params.additionalAmountCents)} is required.`
          : "";

  await sendEmail({
    to: params.email,
    subject: `Booking Modified - ${CLUB_LODGE_NAME}`,
    html: bookingModifiedTemplate(params),
    templateName: "booking-modified",
    templateData: {
      firstName: params.firstName,
      modificationTypeLabel: params.modificationType,
      oldCheckIn: formatNZDate(params.oldCheckIn),
      oldCheckOut: formatNZDate(params.oldCheckOut),
      newCheckIn: formatNZDate(params.newCheckIn),
      newCheckOut: formatNZDate(params.newCheckOut),
      oldGuestCount: params.oldGuestCount,
      newGuestCount: params.newGuestCount,
      oldTotal: formatMoneyCents(params.oldFinalPriceCents),
      newTotal: formatMoneyCents(params.newFinalPriceCents),
      changeFee: formatMoneyCents(params.changeFeeCents),
      refundAmount: formatMoneyCents(params.refundAmountCents),
      accountCreditAmount: formatMoneyCents(accountCreditAmountCents),
      additionalAmount: formatMoneyCents(params.additionalAmountCents),
      additionalPaymentMethod: params.additionalPaymentMethod ?? "",
      paymentReference: params.paymentReference ?? "",
      xeroInvoiceNumber: params.xeroInvoiceNumber ?? "",
      paymentNote,
    },
  });
}

export async function sendSetupIntentFailedEmail(params: {
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
}) {
  await sendEmail({
    to: params.email,
    subject: `Card Setup Failed - ${CLUB_LODGE_NAME}`,
    html: setupIntentFailedTemplate(params),
    templateName: "setup-intent-failed",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
    },
  });
}
