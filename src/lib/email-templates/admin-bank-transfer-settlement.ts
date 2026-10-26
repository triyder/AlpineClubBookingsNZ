/**
 * #3979 (`INV-PAY-125`): the admin alert for a bank transfer the inbound Xero
 * settle recorded but whose figure needs a person - the stored amount was kept
 * instead of the invoice's cash, or the cash is not what the booking owes.
 *
 * Part of the finance/money-event family (`src/lib/email/admin-alerts-finance.ts`
 * and its settlement sub-module `admin-alerts-settlement.ts`); split off from
 * `./admin-finance` for size.
 */
import { escapeHtml } from "./escape";
import { alertBox, button, formatCents, heading, infoTable, layout, paragraph } from "./layout";
import { ibSettlementFigureParagraph, type IbSettlementKeptReason } from "@/lib/ib-settlement-figure-note";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import type { ClubFormat } from "@/lib/club-format";

// ---- #3979: Admin Alert — bank-transfer amount needs checking ----
//
// Its OWN template, not the generic payment-failure mail it first shipped as:
// nothing failed, the money arrived (#2761's finding about that subject). The
// booking and the Xero invoice are one click away, because checking it needs
// both.
export function adminBankTransferSettlementFigureTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  bookingId: string;
  keptReason: IbSettlementKeptReason | null;
  owed: "overpaid" | "underpaid" | null;
  hasSupplementaryInvoice: boolean;
  /** The receipt figure the app recorded. */
  recordedCents: number;
  /** The invoice's cash as Xero reported it. */
  cashCents: number;
  /** What the booking owes, when the cash disagrees with it. */
  owedCents: number | null;
  xeroInvoiceNumber: string | null;
  xeroInvoiceUrl: string | null;
  bookingUrl: string;
  reviewUrl: string;
},
  format: ClubFormat,
): string {
  return layout(`
    ${heading("Bank Transfer Amount Needs Checking")}
    ${alertBox(
      "Xero reports this booking's bank-transfer invoice paid, and the payment has been recorded. The amount needs a person to check it.",
      "warning"
    )}
    ${
      // The SAME sentence the {{settlementFigureNote}} token renders (#2268).
      paragraph(
        ibSettlementFigureParagraph({
          keptReason: data.keptReason,
          owed: data.owed,
          hasSupplementaryInvoice: data.hasSupplementaryInvoice,
        }),
      )
    }
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Amount recorded", value: formatCents(data.recordedCents, format) },
      { label: "Cash Xero shows", value: formatCents(data.cashCents, format) },
      {
        label: "Booking owes",
        value: data.owedCents === null ? "as recorded" : formatCents(data.owedCents, format),
      },
      {
        label: "Xero invoice",
        value: data.xeroInvoiceNumber ? escapeHtml(data.xeroInvoiceNumber) : "unknown",
      },
    ])}
    ${data.xeroInvoiceUrl ? button("Open the invoice in Xero", data.xeroInvoiceUrl) : ""}
    ${button("Open Booking", data.bookingUrl, { sameOrigin: true })}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}
