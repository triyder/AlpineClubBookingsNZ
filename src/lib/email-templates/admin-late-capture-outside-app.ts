/**
 * #4170 (`INV-ADDPAY-038`): the admin alert for a card payment that arrived
 * after its booking was cancelled and was then refunded OUTSIDE the app (the
 * Stripe dashboard). Its own template and an honest subject, never the generic
 * payment-failure mail: nothing failed - money went back that the app did not
 * send, so the app holds no record of it and raised no Xero note (#2761's
 * finding about that subject).
 *
 * Part of the finance/money-event family (`src/lib/email/admin-alerts-late-capture.ts`).
 */
import { escapeHtml } from "./escape";
import { alertBox, button, formatCents, heading, infoTable, layout, paragraph } from "./layout";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import type { ClubFormat } from "@/lib/club-format";
import { LATE_CAPTURE_REFUNDED_OUTSIDE_APP_NOTE } from "@/lib/late-capture-outside-app-note";

export function adminLateCaptureRefundedOutsideAppTemplate(
  data: {
    memberName: string;
    checkIn: Date;
    checkOut: Date;
    bookingId: string;
    paymentIntentId: string;
    refundedCents: number;
    reviewUrl: string;
  },
  format: ClubFormat,
): string {
  return layout(`
    ${heading("Late Payment Refunded Outside the App")}
    ${alertBox(
      "A card payment that arrived after this booking was cancelled has been refunded outside the app - for example in the Stripe dashboard.",
      "warning",
    )}
    ${paragraph(LATE_CAPTURE_REFUNDED_OUTSIDE_APP_NOTE)}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Amount refunded", value: formatCents(data.refundedCents, format) },
      { label: "Stripe reference", value: escapeHtml(data.paymentIntentId) },
    ])}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}
