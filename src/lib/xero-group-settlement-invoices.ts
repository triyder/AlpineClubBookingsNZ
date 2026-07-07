/**
 * Combined group-settlement invoice against Xero.
 *
 * When an ORGANISER_PAYS organiser settles by Internet Banking, the whole group
 * is billed as one combined Xero invoice raised to the organiser's contact, with
 * line items aggregated across every joiner child booking. The invoice is emailed
 * so the organiser can pay it by bank transfer; inbound Xero reconciliation then
 * flips all the joiner children to PAID (see
 * `applyGroupSettlementSucceededFromInvoice` in group-settlement.ts).
 *
 * Mirrors `createXeroInvoiceForBooking`, minus the Stripe payment recording: an
 * Internet Banking invoice is never paid from a Stripe charge, so there is no
 * Xero payment to record here — it is always emailed and reconciled on payment.
 */

import {
  Invoice,
  LineAmountTypes,
  LineItem,
  RequestEmpty,
} from "xero-node";
import { BookingStatus } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { getStayNights } from "./pricing";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "./xero-api-client";
import {
  getHutFeeItemCodeMap,
  getResolvedAccountMapping,
} from "./xero-mappings";
import {
  findOrCreateXeroContact,
  retryXeroWriteWithContactRepair,
  type FindOrCreateXeroContactOptions,
} from "./xero-contacts";
import { buildInvoiceLineItems } from "./xero-booking-invoices";
import { formatDate } from "./xero-invoice-helpers";

export interface CreateXeroGroupSettlementInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

/** The Xero object-link role for a combined settlement invoice. */
const GROUP_SETTLEMENT_INVOICE_ROLE = "GROUP_SETTLEMENT_INVOICE";

/**
 * Raise (or re-link) the single combined Xero invoice for an Internet Banking
 * group settlement and email it to the organiser. Idempotent: a settlement that
 * already carries a `xeroInvoiceId` re-links and returns it without raising a
 * second invoice.
 */
export async function createXeroInvoiceForGroupSettlement(
  settlementId: string,
  options?: CreateXeroGroupSettlementInvoiceOptions
): Promise<string> {
  const settlement = await prisma.groupBookingSettlement.findUnique({
    where: { id: settlementId },
    include: {
      groupBooking: {
        select: {
          id: true,
          organiserMemberId: true,
          organiserBookingId: true,
          organiserBooking: { select: { checkIn: true } },
        },
      },
    },
  });

  if (!settlement) throw new Error(`Group settlement not found: ${settlementId}`);

  // Already raised on a prior attempt: re-assert the link and return it.
  if (settlement.xeroInvoiceId) {
    await upsertXeroObjectLink({
      localModel: "GroupBookingSettlement",
      localId: settlement.id,
      xeroObjectType: "INVOICE",
      xeroObjectId: settlement.xeroInvoiceId,
      xeroObjectNumber: settlement.xeroInvoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(settlement.xeroInvoiceId),
      role: GROUP_SETTLEMENT_INVOICE_ROLE,
    });
    return settlement.xeroInvoiceId;
  }

  const organiserMemberId = settlement.groupBooking.organiserMemberId;

  // The joiner children covered by this settlement: organiser-settled, committed
  // to CONFIRMED (capacity held) and not yet PAID. Their guests/nights become the
  // combined invoice's line items.
  const children = await prisma.booking.findMany({
    where: {
      parentBookingId: settlement.groupBooking.organiserBookingId,
      organiserSettled: true,
      deletedAt: null,
      status: { in: [BookingStatus.CONFIRMED, BookingStatus.PAID] },
    },
    include: { guests: { include: { nights: true } } },
  });

  if (children.length === 0) {
    throw new Error(
      `No settleable children found for group settlement: ${settlementId}`
    );
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(organiserMemberId, options);

  const [hutFeeMapping, hutFeeItemCodeMap] = await Promise.all([
    getResolvedAccountMapping("hutFeesIncome"),
    getHutFeeItemCodeMap(),
  ]);
  const incomeCode = hutFeeMapping.code ?? "200";

  // Build line items per child (each child has its own date range and season),
  // then aggregate across the whole group into one invoice.
  const lineItems: LineItem[] = [];
  for (const child of children) {
    const checkIn = new Date(child.checkIn);
    const checkOut = new Date(child.checkOut);
    const nights = getStayNights(checkIn, checkOut).length;

    let seasonType: string | null = null;
    const season = await prisma.season.findFirst({
      where: {
        startDate: { lte: checkIn },
        endDate: { gte: checkIn },
        active: true,
      },
      select: { type: true },
    });
    if (season) {
      seasonType = season.type;
    }

    lineItems.push(
      ...buildInvoiceLineItems(
        child.guests.map((g) => ({
          firstName: g.firstName,
          lastName: g.lastName,
          ageTier: g.ageTier,
          isMember: g.isMember,
          priceCents: g.priceCents,
          nights: (g.nights ?? []).map((n) => ({
            stayDate: n.stayDate,
            priceCents: n.priceCents,
          })),
        })),
        checkIn,
        checkOut,
        nights,
        incomeCode,
        hutFeeMapping.itemCode,
        hutFeeMapping.codeExplicitlyConfigured,
        hutFeeItemCodeMap.size > 0 ? hutFeeItemCodeMap : undefined,
        seasonType
      )
    );
  }

  const issueDate = formatDate(
    new Date(settlement.groupBooking.organiserBooking.checkIn)
  );
  const dueDate = formatDate(new Date(settlement.createdAt));

  const buildInvoice = (resolvedContactId: string): Invoice => ({
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: resolvedContactId },
    lineItems,
    date: issueDate,
    dueDate,
    reference: `Group settlement ${settlement.groupBooking.id.slice(0, 8)}`,
    status: Invoice.StatusEnum.AUTHORISED,
    lineAmountTypes: LineAmountTypes.Inclusive,
  });

  const invoiceIdempotencyKey = buildXeroIdempotencyKey(
    "group-settlement",
    settlementId,
    "invoice",
    "v1"
  );
  let operationId = options?.syncOperationId ?? null;
  const requestPayload = { invoices: [buildInvoice(contactId)] };

  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: { requestPayload: sanitizeForJson(requestPayload) },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "GroupBookingSettlement",
      localId: settlement.id,
      idempotencyKey: invoiceIdempotencyKey,
      correlationKey: invoiceIdempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: organiserMemberId,
      currentContactId: contactId,
      workflow: "createXeroInvoiceForGroupSettlement",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
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
            workflow: "createXeroInvoiceForGroupSettlement",
            context: `createInvoices(group settlement ${settlementId})`,
          }
        ),
    });

    const createdInvoice = response.body.invoices?.[0];
    if (!createdInvoice?.invoiceID) {
      throw new Error("Failed to create Xero group settlement invoice");
    }

    // Email the invoice so the organiser can pay it by bank transfer.
    let invoiceEmailResponseBody: unknown = null;
    let invoiceEmailError: unknown = null;
    const invoiceEmailIdempotencyKey = buildXeroIdempotencyKey(
      "group-settlement",
      settlementId,
      "invoice-email",
      createdInvoice.invoiceID,
      "v1"
    );
    try {
      const emailResponse = await callXeroApi(
        () =>
          xero.accountingApi.emailInvoice(
            tenantId,
            createdInvoice.invoiceID!,
            new RequestEmpty(),
            invoiceEmailIdempotencyKey
          ),
        {
          operation: "emailInvoice",
          resourceType: "INVOICE",
          workflow: "createXeroInvoiceForGroupSettlement",
          context: `emailInvoice(group settlement ${settlementId})`,
        }
      );
      invoiceEmailResponseBody = emailResponse.body ?? null;
    } catch (error) {
      invoiceEmailError = error;
      logger.warn(
        { err: error, settlementId, invoiceId: createdInvoice.invoiceID },
        "Created Xero group settlement invoice but failed to email it to the organiser"
      );
    }

    await prisma.groupBookingSettlement.update({
      where: { id: settlement.id },
      data: {
        xeroInvoiceId: createdInvoice.invoiceID,
        xeroInvoiceNumber: createdInvoice.invoiceNumber ?? null,
      },
    });

    await completeXeroSyncOperation(operationId!, {
      status: invoiceEmailError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        invoice: response.body,
        invoiceEmail: invoiceEmailResponseBody,
        invoiceEmailError,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: createdInvoice.invoiceID,
      xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
      extraLinks: [
        {
          localModel: "GroupBookingSettlement",
          localId: settlement.id,
          xeroObjectType: "INVOICE",
          xeroObjectId: createdInvoice.invoiceID,
          xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
          role: GROUP_SETTLEMENT_INVOICE_ROLE,
        },
      ],
    });

    return createdInvoice.invoiceID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}
