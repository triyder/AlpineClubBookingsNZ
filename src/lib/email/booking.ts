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
  splitGuestPortionCancelledTemplate,
} from "../email-templates";
import { CLUB_NAME } from "@/config/club-identity";
import { EMAIL_DEFAULT_LODGE_NAME } from "@/lib/email-message-settings";
import {
  formatNZDate,
  formatNZDateTime,
} from "../nzst-date";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { loadEmailMessageSettingsForLodge } from "@/lib/email-message-settings";
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
    // Booking's lodge (multi-lodge phase 8): the email carries this lodge's
    // name, travel note, and door code. Omitted/null resolves the club's
    // default lodge — including its real door code, so always thread the
    // booking's own lodgeId.
    lodgeId?: string | null;
    // Split-booking parent (#738): describes the provisional non-member child
    // whose places are charged separately around the hold deadline. Present
    // only when this confirmation is a split parent (see
    // getProvisionalNonMemberChildSummary). Read-only email content — it never
    // changes the hold/settlement decision.
    provisionalGuests?: {
      guestCount: number;
      holdUntil: Date;
    };
  },
) {
  const settings = await loadEmailMessageSettingsForLodge(options?.lodgeId);
  const promoAdjustmentCents =
    options?.promoAdjustmentCents ??
    (options?.discountCents && options.discountCents > 0
      ? -options.discountCents
      : 0);
  const promoAdjustmentPrefix = promoAdjustmentCents > 0 ? "+" : "-";
  const provisionalGuests = options?.provisionalGuests;
  // Composed sentence for the {{provisionalGuestsNote}} token — the same story
  // the FILE template renders, so an operator override keeps parity. Empty when
  // this is not a split parent so the token renders nothing.
  const provisionalGuestsNote =
    provisionalGuests && provisionalGuests.guestCount > 0
      ? `Your ${provisionalGuests.guestCount} non-member guest${
          provisionalGuests.guestCount === 1 ? "" : "s"
        } ${
          provisionalGuests.guestCount === 1 ? "is" : "are"
        } held provisionally as a linked booking — no bed is reserved for them yet, and the payment above covers only your member places. If beds remain around ${formatNZDateTime(
          provisionalGuests.holdUntil,
        )}, we'll automatically take that guest portion from your saved payment method and your guests are confirmed. If we can't take payment, we'll contact you to arrange it. If the lodge fills with member bookings first, that portion is not charged and those guests are bumped.`
      : "";
  await sendEmail({
    to: email,
    subject: `Booking Confirmed - ${EMAIL_DEFAULT_LODGE_NAME}`,
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
        provisionalGuests,
      },
    ),
    templateName: "booking-confirmed",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
      provisionalGuestsNote,
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
    lodgeId: options?.lodgeId,
  });
}

export async function sendBookingPendingEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  holdUntil: Date,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Booking Pending - ${EMAIL_DEFAULT_LODGE_NAME}`,
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
    lodgeId,
  });
}

export async function sendBookingBumpedEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Booking Update - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: bookingBumpedTemplate(firstName, checkIn, checkOut, guestCount),
    templateName: "booking-bumped",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
    },
    lodgeId,
  });
}

export async function sendBookingGuestsCancelledEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Booking Cancelled - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: bookingGuestsCancelledTemplate(firstName, checkIn, checkOut),
    templateName: "booking-guests-cancelled",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
    },
    lodgeId,
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
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Booking Cancelled - ${EMAIL_DEFAULT_LODGE_NAME}`,
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
    lodgeId,
  });
}

/**
 * #1993 Part A: member notice that the provisional non-member guest portion of
 * their stay was auto-cancelled because it stayed unpaid up to the check-in day.
 * Replaces the misleading generic booking-cancelled email on the terminal path:
 * nothing was ever charged for the guest portion, and their own linked booking
 * is untouched. `parentConfirmed` selects the reassurance wording (see the
 * template); `parentBookingReference` is shown when cheaply available.
 */
export async function sendSplitGuestPortionCancelledEmail(params: {
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  parentConfirmed: boolean;
  parentBookingReference?: string | null;
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your guests' provisional place was cancelled — ${CLUB_NAME}`,
    html: splitGuestPortionCancelledTemplate({
      firstName: params.firstName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      parentConfirmed: params.parentConfirmed,
      parentBookingReference: params.parentBookingReference ?? null,
    }),
    templateName: "split-guest-portion-cancelled",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      bookingReference: params.parentBookingReference ?? "",
    },
    lodgeId: params.lodgeId,
  });
}

export async function sendBookingReviewApprovedEmail(params: {
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  adminNotes: string;
  bookingId: string;
  // Booking's lodge (multi-lodge phase 8); omitted/null resolves the
  // default lodge identity — always thread the booking's own lodgeId.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your booking has been approved - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: bookingReviewApprovedTemplate(
      params.firstName,
      params.checkIn,
      params.checkOut,
      params.adminNotes,
      params.bookingId,
    ),
    templateName: "booking-review-approved",
    lodgeId: params.lodgeId,
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
  // Booking's lodge (multi-lodge phase 8); omitted/null resolves the
  // default lodge identity — always thread the booking's own lodgeId.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your booking could not be approved - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: bookingReviewRejectedTemplate(
      params.firstName,
      params.checkIn,
      params.checkOut,
      params.adminNotes,
    ),
    templateName: "booking-review-rejected",
    lodgeId: params.lodgeId,
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
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Check-in Reminder - ${EMAIL_DEFAULT_LODGE_NAME}`,
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
    lodgeId,
  });
}

export async function sendPreArrivalReminderEmail(params: {
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expectedArrivalTime?: string | null;
  // Booking's lodge (multi-lodge phase 8): the email carries this lodge's
  // name, travel note, and door code. Omitted/null resolves the club's
  // default lodge — including its real door code, so always thread the
  // booking's own lodgeId.
  lodgeId?: string | null;
}) {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);
  await sendEmail({
    to: params.email,
    subject: `Pre-arrival Information - ${EMAIL_DEFAULT_LODGE_NAME}`,
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
    lodgeId: params.lodgeId,
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
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null;
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
    subject: `Booking Modified - ${EMAIL_DEFAULT_LODGE_NAME}`,
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
    lodgeId: params.lodgeId,
  });
}

export async function sendSetupIntentFailedEmail(params: {
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Card Setup Failed - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: setupIntentFailedTemplate(params),
    templateName: "setup-intent-failed",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
    },
    lodgeId: params.lodgeId,
  });
}
