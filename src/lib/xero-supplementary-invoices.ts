/**
 * Supplementary Xero invoices for positive booking modifications.
 *
 * When a booking modification increases the total (extra guests, longer
 * stay, switch to a higher rate), `createXeroSupplementaryInvoice`
 * creates a small invoice for the delta and records the matching Stripe
 * payment if one has already settled.
 */

import {
  Invoice,
  LineItem,
  LineAmountTypes,
  Payment as XeroPayment,
} from "xero-node";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "./xero-api-client";
import {
  getAccountMapping,
  getResolvedAccountMapping,
} from "./xero-mappings";
import {
  findOrCreateXeroContact,
  retryXeroWriteWithContactRepair,
  type FindOrCreateXeroContactOptions,
} from "./xero-contacts";
import { formatDate } from "./xero-invoice-helpers";

export interface CreateXeroSupplementaryInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

export async function createXeroSupplementaryInvoice(params: {
  bookingId: string;
  priceDiffCents: number;
  changeFeeCents: number;
  bookingModificationId?: string;
  createdByMemberId?: string;
  recordPayment?: boolean;
  repairExistingLink?: boolean;
  syncOperationId?: string;
}): Promise<string | null> {
  const {
    bookingId,
    priceDiffCents,
    changeFeeCents,
    bookingModificationId,
    createdByMemberId,
    recordPayment = true,
    repairExistingLink,
    syncOperationId,
  } = params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, member: true },
  });

  if (!booking?.payment?.xeroInvoiceId) {
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: {
          skipped: true,
          reason: "No original Xero invoice exists for this booking.",
        },
      });
    }
    return null;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(booking.memberId, {
    createdByMemberId,
    repairExistingLink,
  });
  const incomeMapping = await getResolvedAccountMapping("hutFeesIncome");
  const incomeCode = incomeMapping.code ?? "200";

  const lineItems: LineItem[] = [];

  if (priceDiffCents > 0) {
    const li: LineItem = {
      description: `Booking modification - price adjustment (Booking ${bookingId.slice(0, 8)})`,
      quantity: 1,
      unitAmount: priceDiffCents / 100,
      taxType: "OUTPUT2",
    };
    if (incomeMapping.itemCode) li.itemCode = incomeMapping.itemCode;
    if (!incomeMapping.itemCode || incomeCode !== "200" || incomeMapping.codeExplicitlyConfigured) {
      li.accountCode = incomeCode;
    }
    lineItems.push(li);
  }

  if (changeFeeCents > 0) {
    const li: LineItem = {
      description: "Late notice booking change fee",
      quantity: 1,
      unitAmount: changeFeeCents / 100,
      taxType: "OUTPUT2",
    };
    if (incomeMapping.itemCode) li.itemCode = incomeMapping.itemCode;
    if (!incomeMapping.itemCode || incomeCode !== "200" || incomeMapping.codeExplicitlyConfigured) {
      li.accountCode = incomeCode;
    }
    lineItems.push(li);
  }

  if (lineItems.length === 0) {
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: {
          skipped: true,
          reason: "Supplementary invoice has no billable line items.",
        },
      });
    }
    return null;
  }

  const bookingModification = bookingModificationId
    ? await prisma.bookingModification.findUnique({
        where: { id: bookingModificationId },
        select: { createdAt: true },
      })
    : null;
  const supplementaryInvoiceDueDate = formatDate(
    bookingModification?.createdAt ?? new Date()
  );

  const buildInvoice = (resolvedContactId: string): Invoice => ({
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: resolvedContactId },
    lineItems,
    date: formatDate(new Date()),
    dueDate: supplementaryInvoiceDueDate,
    reference: `Supplementary for booking ${bookingId.slice(0, 8)}${booking.payment?.xeroInvoiceId ? ` (original: ${booking.payment.xeroInvoiceId})` : ""}`,
    status: Invoice.StatusEnum.AUTHORISED,
    lineAmountTypes: LineAmountTypes.Inclusive,
  });

  const localModel = bookingModificationId ? "BookingModification" : "Booking";
  const localId = bookingModificationId ?? bookingId;
  const invoiceIdempotencyKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    "supplementary-invoice",
    priceDiffCents,
    changeFeeCents,
    "v1"
  );
  let operationId = syncOperationId ?? null;
  const requestPayload = { invoices: [buildInvoice(contactId)] };

  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        requestPayload: sanitizeForJson(requestPayload),
      },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel,
      localId,
      idempotencyKey: invoiceIdempotencyKey,
      correlationKey: invoiceIdempotencyKey,
      requestPayload,
      createdByMemberId: createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: booking.memberId,
      currentContactId: contactId,
      workflow: "createXeroSupplementaryInvoice",
      operationId: operationId!,
      repairExistingLink,
      createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        invoices: [buildInvoice(resolvedContactId)],
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createInvoices(
              tenantId,
              { invoices: [buildInvoice(resolvedContactId)] },
              undefined,
              undefined,
              invoiceIdempotencyKey
            ),
          {
            operation: "createInvoices",
            resourceType: "INVOICE",
            workflow: "createXeroSupplementaryInvoice",
            context: `createInvoices(supplementary ${localId})`,
          }
        ),
    });

    const created = response.body.invoices?.[0];
    if (!created?.invoiceID) {
      throw new Error("Failed to create supplementary Xero invoice");
    }

    let paymentResponseBody: XeroPayment | null = null;
    let paymentError: unknown = null;
    const paymentSkipped = !recordPayment;
    const paymentSkipReason = paymentSkipped
      ? "Supplementary invoice payment recording is deferred until an additional Stripe payment succeeds or an admin records payment."
      : null;

    if (recordPayment) {
      try {
        const stripeBankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
        const totalCents = priceDiffCents + changeFeeCents;
        const paymentIdempotencyKey = buildXeroIdempotencyKey(
          bookingModificationId ? "booking-mod" : "booking",
          localId,
          "supplementary-payment",
          totalCents,
          "v1"
        );
        const paymentResponse = await callXeroApi(
          () =>
            xero.accountingApi.createPayments(
              tenantId,
              {
                payments: [{
                  invoice: { invoiceID: created.invoiceID },
                  account: { code: stripeBankCode },
                  amount: totalCents / 100,
                  date: formatDate(new Date()),
                  reference: `Stripe payment for booking modification ${bookingId.slice(0, 8)}`,
                }],
              },
              undefined,
              paymentIdempotencyKey
            ),
          {
            operation: "createPayments",
            resourceType: "PAYMENT",
            workflow: "createXeroSupplementaryInvoice",
            context: `createPayments(supplementary ${localId})`,
          }
        );
        paymentResponseBody = paymentResponse.body.payments?.[0] ?? null;
      } catch (error) {
        paymentError = error;
        // Non-fatal: invoice exists, payment recording is for reconciliation convenience
        logger.warn({ err: error, invoiceId: created.invoiceID }, "Failed to record Xero payment for supplementary invoice");
      }
    } else {
      logger.info(
        { bookingId, invoiceId: created.invoiceID },
        "Skipping Xero payment recording for supplementary invoice"
      );
    }

    await completeXeroSyncOperation(operationId!, {
      status: paymentError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        invoice: response.body,
        payment: paymentResponseBody,
        paymentError,
        paymentSkipped,
        paymentSkipReason,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: created.invoiceID,
      xeroObjectNumber: created.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
      extraLinks: [
        {
          localModel,
          localId,
          xeroObjectType: "INVOICE",
          xeroObjectId: created.invoiceID,
          xeroObjectNumber: created.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
          role: "SUPPLEMENTARY_INVOICE",
        },
        ...(paymentResponseBody?.paymentID
          ? [
              {
                localModel,
                localId,
                xeroObjectType: "PAYMENT",
                xeroObjectId: paymentResponseBody.paymentID,
                xeroObjectNumber: paymentResponseBody.invoiceNumber ?? null,
                role: "SUPPLEMENTARY_INVOICE_PAYMENT",
                metadata: {
                  invoiceId: created.invoiceID,
                  amountCents: priceDiffCents + changeFeeCents,
                },
              },
            ]
          : []),
      ],
    });

    return created.invoiceID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

/**
 * Create a Xero credit note when a booking modification decreases the price.
 *
 * Fire-and-forget: caller should catch errors and log them.
 */
