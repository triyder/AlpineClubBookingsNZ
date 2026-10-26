/**
 * #3403 (`INV-PAY-140`): WHERE A WAITING SUPPLEMENTARY INVOICE'S MONEY WAS FIRST
 * ASKED FOR. A leaf, so a price reduction can read it without importing the
 * move (`superseded-ask-invoice-carry.ts`) or the outbox.
 */
import { asRecord, readString } from "@/lib/xero-json";

/** The payload key naming the intent a supplementary invoice first waited on, before a supersession moved it. */
export const SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY = "parkedFromPaymentIntentId";

/**
 * #3403 review 2 (F2): set where the move onto an already-captured carrier
 * turned the invoice unpaid because the carrier's own receipt records that
 * capture. A capture of the superseded ask that takes the invoice back
 * decides `recordPayment` again for ITS capture, so the unpaid the move wrote
 * for the carrier's never survives the return.
 */
export const SUPPLEMENTARY_INVOICE_MOVED_UNPAID_KEY = "movedUnpaidOntoCarrier";

/**
 * #3403 review 2 (F3): written by that return - the request the invoice was
 * taken back from. Its capture carried this change's balance too, so if the
 * club keeps it as well the change was paid twice; its release tells an
 * officer once.
 */
export const SUPPLEMENTARY_INVOICE_TAKEN_BACK_FROM_KEY = "takenBackFromPaymentIntentId";

/**
 * The intent whose ask a waiting supplementary invoice's money was first asked
 * on: the one it was parked on, or, once a supersession moved it onto the
 * request carrying its balance (`followSupersededAskInvoicesToCarrier`), the
 * one it was moved from, kept through later moves. A price reduction
 * attributes a parked invoice to a row of the unpaid chain by this
 * (`retireUnpaidAskChain`), so a moved invoice still reads as the superseded
 * row's own money, not the carrier's.
 */
export function supplementaryInvoiceWaitedFirstOn(requestPayload: unknown): string | null {
  const payload = asRecord(requestPayload);
  return readString(payload?.[SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY]) ?? readString(payload?.paymentIntentId);
}
