import {
  waitlistConfirmationTemplate,
  waitlistOfferTemplate,
  waitlistOfferExpiredTemplate,
} from "../email-templates";
import { CLUB_LODGE_NAME } from "@/config/club-identity";
import {
  formatNZDate,
  formatNZDateTime,
} from "../nzst-date";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendEmail } from "./core";

// ---- Waitlist emails ----

export async function sendWaitlistConfirmationEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  position: number,
) {
  await sendEmail({
    to: email,
    subject: `Waitlist Confirmation - ${CLUB_LODGE_NAME}`,
    html: waitlistConfirmationTemplate(
      firstName,
      checkIn,
      checkOut,
      guestCount,
      position,
    ),
    templateName: "waitlist-confirmation",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
      position,
    },
  });
}

export async function sendWaitlistOfferEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  expiresAt: Date,
  bookingId: string,
  priceCents: number,
) {
  await sendEmail({
    to: email,
    subject: `Spot Available! - ${CLUB_LODGE_NAME}`,
    html: waitlistOfferTemplate(
      firstName,
      checkIn,
      checkOut,
      guestCount,
      expiresAt,
      bookingId,
      priceCents,
    ),
    templateName: "waitlist-offer",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
      // The price the member pays on confirmation (repriced at offer time, #1035).
      price: formatMoneyCents(priceCents),
      expiresAt: formatNZDateTime(expiresAt),
      bookingId,
    },
  });
}

export async function sendWaitlistOfferExpiredEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  position: number,
) {
  await sendEmail({
    to: email,
    subject: `Waitlist Offer Expired - ${CLUB_LODGE_NAME}`,
    html: waitlistOfferExpiredTemplate(firstName, checkIn, checkOut, position),
    templateName: "waitlist-offer-expired",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      position,
    },
  });
}
