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
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
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
    lodgeId,
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
  // Price the member pays on confirmation (upstream #1035): the offer-time
  // reprice for same-lodge offers, or the offered lodge's quote for a
  // cross-lodge offer.
  priceCents: number,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  // A cross-lodge offer passes the OFFERED lodge here so the message
  // carries that lodge's identity.
  lodgeId?: string | null,
  // Cross-lodge offer (ADR-004): names the alternate lodge the member is
  // being offered. Null for same-lodge offers, which render as before.
  crossLodgeOffer?: { lodgeName: string | null } | null,
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
      crossLodgeOffer,
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
      ...(crossLodgeOffer
        ? { offeredLodgeName: crossLodgeOffer.lodgeName }
        : {}),
    },
    lodgeId,
  });
}

export async function sendWaitlistOfferExpiredEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  position: number,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
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
    lodgeId,
  });
}
