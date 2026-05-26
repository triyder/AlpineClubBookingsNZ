/**
 * Xero Integration Library — booking invoice surface and compatibility facade.
 *
 * Higher-level domain modules now own their concerns:
 *   - infrastructure (OAuth/token storage, metered API + retry) in xero-oauth,
 *     xero-token-store, and xero-api-client
 *   - reference mappings in xero-mappings
 *   - contact CRUD + retry-with-repair in xero-contacts
 *   - cached contact snapshots in xero-contact-cache
 *   - contact group cache + managed group sync in xero-contact-groups
 *   - bulk contact sync + member import in xero-bulk-contact-sync
 *   - membership invoice sync in xero-membership-sync
 *
 * The booking-invoice / credit-note / refund-payment / supplementary
 * invoice / modification credit-note / entrance-fee invoice flows still
 * live here. This file also re-exports the historical public surface so
 * `@/lib/xero` callers continue to work without churn.
 */

import {
  Invoice,
  Invoices,
  LineItem,
  LineAmountTypes,
  CreditNote,
  Payment as XeroPayment,
  type XeroClient,
} from "xero-node";
import { CreditType } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { getStayNights } from "./pricing";
import { CLUB_NAME } from "@/config/club-identity";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  findCanonicalPaymentRefundCreditNote,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  isRetryableXeroContactReferenceError,
  resetXeroRateLimitStateForTests,
  withXeroRetry,
  XeroDailyLimitError,
  XeroTransientOutageError,
  type MeteredXeroCallOptions,
} from "./xero-api-client";
import {
  buildEntranceFeeInvoiceIdempotencyKey,
  determineEntranceFeeCategory,
  getAccountMapping,
  getEntranceFeeContext,
  getEntranceFeeMapping,
  getHutFeeItemCodeMap,
  getItemCodeMapping,
  getResolvedAccountMapping,
  type EntranceFeeContext,
  type ResolvedAccountMapping,
} from "./xero-mappings";
import {
  createXeroClient,
  disconnectXero,
  getXeroConsentUrl,
  handleXeroCallback,
} from "./xero-oauth";
import {
  decryptToken,
  encryptToken,
  getXeroConnectionStatus,
  isXeroConnected,
} from "./xero-token-store";
import {
  buildMemberFullName,
  buildXeroAddresses,
  createXeroContactForMember,
  findOrCreateXeroContact,
  retryXeroWriteWithContactRepair,
  updateXeroContact,
  XeroContactValidationError,
  type FindOrCreateXeroContactOptions,
  type XeroContactUpdateData,
} from "./xero-contacts";
import {
  findDuplicateContacts,
  findPotentialXeroContactsForMember,
  type DuplicateContact,
  type DuplicateGroup,
  type PotentialXeroContactMatch,
} from "./xero-duplicate-contacts";
import {
  refreshXeroContactCachesFromContact,
  refreshXeroContactGroupMembershipCacheForContact,
  type CachedXeroContact,
  type RefreshXeroContactCachesFromContactResult,
  type RefreshXeroContactGroupMembershipCacheForContactResult,
} from "./xero-contact-cache";
import {
  getXeroContactGroupMemberships,
  getXeroContactGroups,
  getXeroContactIdsForGroup,
  refreshXeroContactGroupCache,
  syncManagedXeroContactGroupForMember,
  type SyncManagedMemberXeroContactGroupResult,
} from "./xero-contact-groups";
import {
  syncContactsFromXero,
  type SyncReport,
} from "./xero-bulk-contact-sync";
import { importMembersFromXeroGroups } from "./xero-member-import";
import {
  checkMembershipStatus,
  determineSubscriptionStatus,
  findSubscriptionInvoice,
  flushMemberSubscriptionHistory,
  refreshAllMembershipStatuses,
  shouldBackfillMembershipStatus,
  syncMemberSubscriptionHistoryForLinkedContact,
} from "./xero-membership-sync";

// ---------------------------------------------------------------------------
// Re-export the public surface that used to live in this file. Existing
// callers import from "@/lib/xero"; keep that contract while the underlying
// concerns live in dedicated modules.
// ---------------------------------------------------------------------------

export {
  callXeroApi,
  getAuthenticatedXeroClient,
  isRetryableXeroContactReferenceError,
  resetXeroRateLimitStateForTests,
  withXeroRetry,
  XeroDailyLimitError,
  XeroTransientOutageError,
};
export type { MeteredXeroCallOptions };

export {
  buildEntranceFeeInvoiceIdempotencyKey,
  determineEntranceFeeCategory,
  getAccountMapping,
  getEntranceFeeContext,
  getEntranceFeeMapping,
  getHutFeeItemCodeMap,
  getItemCodeMapping,
  getResolvedAccountMapping,
};
export type { EntranceFeeContext, ResolvedAccountMapping };

export {
  createXeroClient,
  disconnectXero,
  getXeroConsentUrl,
  handleXeroCallback,
};

export {
  decryptToken,
  encryptToken,
  getXeroConnectionStatus,
  isXeroConnected,
};

export {
  XeroContactValidationError,
  buildMemberFullName,
  buildXeroAddresses,
  createXeroContactForMember,
  findDuplicateContacts,
  findOrCreateXeroContact,
  findPotentialXeroContactsForMember,
  retryXeroWriteWithContactRepair,
  updateXeroContact,
};
export type {
  DuplicateContact,
  DuplicateGroup,
  FindOrCreateXeroContactOptions,
  PotentialXeroContactMatch,
  XeroContactUpdateData,
};

export {
  refreshXeroContactCachesFromContact,
  refreshXeroContactGroupMembershipCacheForContact,
};
export type {
  CachedXeroContact,
  RefreshXeroContactCachesFromContactResult,
  RefreshXeroContactGroupMembershipCacheForContactResult,
};

export {
  getXeroContactGroupMemberships,
  getXeroContactGroups,
  getXeroContactIdsForGroup,
  refreshXeroContactGroupCache,
  syncManagedXeroContactGroupForMember,
};
export type { SyncManagedMemberXeroContactGroupResult };

export { importMembersFromXeroGroups, syncContactsFromXero };
export type { SyncReport };

export {
  checkMembershipStatus,
  determineSubscriptionStatus,
  findSubscriptionInvoice,
  flushMemberSubscriptionHistory,
  refreshAllMembershipStatuses,
  shouldBackfillMembershipStatus,
  syncMemberSubscriptionHistoryForLinkedContact,
};

// ---------------------------------------------------------------------------
// Booking-invoice option types (kept here because the invoice flows below
// consume them directly).
// ---------------------------------------------------------------------------

export interface CreateXeroEntranceFeeInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
  precomputedEntranceFee?: EntranceFeeContext;
}

export interface CreateXeroBookingInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

export interface UpdateXeroBookingInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

export interface CreateXeroRefundCreditNoteOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

export interface CreateXeroSupplementaryInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

export interface CreateXeroModificationCreditNoteOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

export interface CreateXeroUnappliedCreditNoteOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

// ---------------------------------------------------------------------------
// Invoice creation (TAC -> Xero)
// ---------------------------------------------------------------------------

/**
 * Build Xero invoice line items from a booking's guests and stay nights.
 * Exported for testing.
 *
 * @param itemCodeMap - Per-guest item code lookup keyed by "${ageTier}_${seasonType}_${isMember}".
 *   When provided with a seasonType, each guest gets their own item code based on their
 *   age tier, membership status, and the booking's season type.
 * @param itemCode - Legacy single item code applied to all guests (used when itemCodeMap is empty).
 */
export function buildInvoiceLineItems(
  guests: Array<{
    firstName: string;
    lastName: string;
    ageTier: string;
    isMember: boolean;
    priceCents: number;
  }>,
  checkIn: Date,
  checkOut: Date,
  nights: number,
  accountCode: string = "200",
  itemCode?: string | null,
  accountCodeExplicitlyConfigured: boolean = false,
  itemCodeMap?: Map<string, string>,
  seasonType?: string | null,
): LineItem[] {
  return guests.map((guest) => {
    const perNightCents = nights > 0 ? Math.round(guest.priceCents / nights) : guest.priceCents;
    const description = [
      `${guest.firstName} ${guest.lastName}`,
      `(${guest.ageTier}${guest.isMember ? ", Member" : ", Non-member"})`,
      `${nights} night${nights !== 1 ? "s" : ""}`,
      `${formatDate(checkIn)} - ${formatDate(checkOut)}`,
    ].join(" - ");

    const lineItem: LineItem = {
      description,
      quantity: nights,
      unitAmount: perNightCents / 100, // Xero uses dollars, not cents
      taxType: "OUTPUT2", // GST on Income (NZ)
    };

    // Resolve item code: prefer per-guest granular mapping, fall back to legacy flat code
    const guestItemCode = (itemCodeMap && seasonType)
      ? (itemCodeMap.get(`${guest.ageTier}_${seasonType}_${guest.isMember}`) ?? null)
      : (itemCode ?? null);

    // If itemCode is set, Xero auto-fills the account from the Item's config.
    // If accountCode is also explicitly configured, it overrides the Item's default.
    if (guestItemCode) {
      lineItem.itemCode = guestItemCode;
    }
    // Include the account code when there is no item code, when a non-default account
    // is supplied, or when the admin explicitly configured the default account code to
    // override the selected Xero Item's own default.
    if (!guestItemCode || accountCode !== "200" || accountCodeExplicitlyConfigured) {
      lineItem.accountCode = accountCode;
    }

    return lineItem;
  });
}

export function buildEntranceFeeLineItem(
  categoryLabel: string,
  amountCents: number,
  accountCode: string = "200",
  itemCode?: string | null,
  accountCodeExplicitlyConfigured: boolean = false,
  descriptionOverride?: string | null,
): LineItem {
  const lineItem: LineItem = {
    quantity: 1,
    unitAmount: amountCents / 100,
    taxType: "OUTPUT2",
  };

  const description = descriptionOverride?.trim();
  if (itemCode) {
    lineItem.itemCode = itemCode;
    if (description) {
      lineItem.description = description;
    }
  } else {
    lineItem.description = description || `Membership entrance fee (${categoryLabel})`;
  }

  if (!itemCode || accountCode !== "200" || accountCodeExplicitlyConfigured) {
    lineItem.accountCode = accountCode;
  }

  return lineItem;
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function getBookingInvoiceIssueDate(booking: { checkIn: Date | string }): string {
  return formatDate(new Date(booking.checkIn));
}

function getBookingInvoiceDueDate(booking: { createdAt: Date | string }): string {
  return formatDate(new Date(booking.createdAt));
}

function buildSyntheticAllocationId(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number
): string {
  return buildXeroIdempotencyKey(
    "allocation",
    creditNoteId,
    invoiceId,
    amountCents,
    "v1"
  );
}

interface CreateXeroInvoicePaymentParams {
  localModel: string;
  localId: string;
  invoiceId: string;
  amountCents: number;
  idempotencyKey: string;
  reference: string;
  role: string;
  createdByMemberId?: string;
  metadata?: Record<string, unknown>;
}

export async function createXeroPaymentForInvoice(
  params: CreateXeroInvoicePaymentParams
): Promise<string> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const bankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
  const payment: XeroPayment = {
    invoice: { invoiceID: params.invoiceId },
    account: { code: bankCode },
    amount: params.amountCents / 100,
    date: formatDate(new Date()),
    reference: params.reference,
  };

  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "PAYMENT",
    operationType: "CREATE",
    localModel: params.localModel,
    localId: params.localId,
    idempotencyKey: params.idempotencyKey,
    correlationKey: params.idempotencyKey,
    requestPayload: { payments: [payment] },
    createdByMemberId: params.createdByMemberId ?? null,
  });

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createPayments(
          tenantId,
          { payments: [payment] },
          undefined,
          params.idempotencyKey
        ),
      {
        operation: "createPayments",
        resourceType: "PAYMENT",
        workflow: "createXeroPaymentForInvoice",
        context: `createPayment(${params.localModel} ${params.localId})`,
      }
    );

    const createdPayment = response.body.payments?.[0];
    if (!createdPayment?.paymentID) {
      throw new Error("Failed to create Xero payment");
    }

    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "PAYMENT",
      xeroObjectId: createdPayment.paymentID,
      xeroObjectNumber: createdPayment.invoiceNumber ?? null,
      extraLinks: [
        {
          localModel: params.localModel,
          localId: params.localId,
          xeroObjectType: "PAYMENT",
          xeroObjectId: createdPayment.paymentID,
          xeroObjectNumber: createdPayment.invoiceNumber ?? null,
          role: params.role,
          metadata: params.metadata,
        },
      ],
    });

    return createdPayment.paymentID;
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

interface CreateXeroRefundPaymentParams {
  paymentId: string;
  invoiceId: string;
  creditNoteId: string;
  refundAmountCents: number;
  createdByMemberId?: string;
}

const REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON =
  "Refund credit notes are settled via a credit-note payment instead of invoice allocation.";

function buildRefundCreditNotePayment(params: {
  paymentId: string;
  creditNoteId: string;
  refundAmountCents: number;
  bankCode: string;
}): XeroPayment {
  return {
    creditNote: { creditNoteID: params.creditNoteId },
    account: { code: params.bankCode },
    amount: params.refundAmountCents / 100,
    date: formatDate(new Date()),
    reference: `Stripe Refund - ${CLUB_NAME} payment ${params.paymentId.slice(0, 8)}`,
    isReconciled: false,
  };
}

export async function createXeroRefundPaymentForInvoice(
  params: CreateXeroRefundPaymentParams
): Promise<string> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const bankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
  const payment = buildRefundCreditNotePayment({
    paymentId: params.paymentId,
    creditNoteId: params.creditNoteId,
    refundAmountCents: params.refundAmountCents,
    bankCode,
  });
  const idempotencyKey = buildXeroIdempotencyKey(
    "payment",
    params.paymentId,
    "refund-payment",
    params.refundAmountCents,
    "v1"
  );
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "PAYMENT",
    operationType: "CREATE",
    localModel: "Payment",
    localId: params.paymentId,
    idempotencyKey,
    correlationKey: idempotencyKey,
    requestPayload: {
      payments: [payment],
      invoiceId: params.invoiceId,
      creditNoteId: params.creditNoteId,
    },
    createdByMemberId: params.createdByMemberId ?? null,
  });

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createPayments(
          tenantId,
          { payments: [payment] },
          undefined,
          idempotencyKey
        ),
      {
        operation: "createPayments",
        resourceType: "PAYMENT",
        workflow: "createXeroRefundPaymentForInvoice",
        context: `createPayments(refund repair ${params.paymentId})`,
      }
    );

    const createdPayment = response.body.payments?.[0];
    if (!createdPayment?.paymentID) {
      throw new Error("Failed to create Xero refund payment");
    }
    const createdPaymentNumber =
      createdPayment.creditNoteNumber
      ?? createdPayment.invoiceNumber
      ?? (
        (createdPayment as unknown as {
          creditNote?: { creditNoteNumber?: string | null; CreditNoteNumber?: string | null } | null;
        }).creditNote?.creditNoteNumber
        ?? (createdPayment as unknown as {
          creditNote?: { creditNoteNumber?: string | null; CreditNoteNumber?: string | null } | null;
        }).creditNote?.CreditNoteNumber
        ?? null
      );

    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "PAYMENT",
      xeroObjectId: createdPayment.paymentID,
      xeroObjectNumber: createdPaymentNumber,
      extraLinks: [
        {
          localModel: "Payment",
          localId: params.paymentId,
          xeroObjectType: "PAYMENT",
          xeroObjectId: createdPayment.paymentID,
          xeroObjectNumber: createdPaymentNumber,
          role: "REFUND_PAYMENT",
          metadata: {
            creditNoteId: params.creditNoteId,
            invoiceId: params.invoiceId,
            amountCents: params.refundAmountCents,
          },
        },
      ],
    });

    return createdPayment.paymentID;
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

/**
 * Create a Xero invoice for a confirmed booking.
 * This is the main function that other phases should call after booking confirmation.
 *
 * @param bookingId - The booking to create an invoice for
 * @returns The Xero invoice ID
 */
export async function createXeroInvoiceForBooking(
  bookingId: string,
  options?: CreateXeroBookingInvoiceOptions
): Promise<string> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      guests: true,
      payment: true,
    },
  });

  if (!booking) throw new Error(`Booking not found: ${bookingId}`);
  if (!booking.payment) throw new Error(`No payment record for booking: ${bookingId}`);

  // Skip if invoice already created
  if (booking.payment.xeroInvoiceId) {
    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: booking.payment.id,
      xeroObjectType: "INVOICE",
      xeroObjectId: booking.payment.xeroInvoiceId,
      xeroObjectNumber: booking.payment.xeroInvoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(booking.payment.xeroInvoiceId),
      role: "PRIMARY_INVOICE",
    });
    return booking.payment.xeroInvoiceId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Ensure the member has a Xero contact
  const contactId = await findOrCreateXeroContact(booking.memberId, options);

  // Resolve account codes, item codes, and season type
  const [hutFeeMapping, stripeBankCode, hutFeeItemCodeMap] = await Promise.all([
    getResolvedAccountMapping("hutFeesIncome"),
    getAccountMapping("stripeBankAccount"),
    getHutFeeItemCodeMap(),
  ]);
  const incomeCode = hutFeeMapping.code ?? "200";
  const bankCode = stripeBankCode ?? "606";

  // Calculate nights using the same logic as the pricing engine
  const checkIn = new Date(booking.checkIn);
  const checkOut = new Date(booking.checkOut);
  const nights = getStayNights(checkIn, checkOut).length;

  // Determine season type from check-in date for item code mapping
  let bookingSeasonType: string | null = null;
  const season = await prisma.season.findFirst({
    where: {
      startDate: { lte: checkIn },
      endDate: { gte: checkIn },
      active: true,
    },
    select: { type: true },
  });
  if (season) {
    bookingSeasonType = season.type;
  }

  // Build line items with per-guest item codes
  const lineItems = buildInvoiceLineItems(
    booking.guests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      priceCents: g.priceCents,
    })),
    checkIn,
    checkOut,
    nights,
    incomeCode,
    hutFeeMapping.itemCode,
    hutFeeMapping.codeExplicitlyConfigured,
    hutFeeItemCodeMap.size > 0 ? hutFeeItemCodeMap : undefined,
    bookingSeasonType,
  );

  // Add discount line if applicable
  if (booking.discountCents > 0) {
    // Use the first guest's item code for the discount, or fall back to legacy
    const firstGuest = booking.guests[0];
    const discountItemCode = (hutFeeItemCodeMap.size > 0 && bookingSeasonType && firstGuest)
      ? (hutFeeItemCodeMap.get(`${firstGuest.ageTier}_${bookingSeasonType}_${firstGuest.isMember}`) ?? hutFeeMapping.itemCode)
      : hutFeeMapping.itemCode;

    const discountLineItem: LineItem = {
      description: "Discount",
      quantity: 1,
      unitAmount: -(booking.discountCents / 100),
      taxType: "OUTPUT2",
    };
    if (discountItemCode) {
      discountLineItem.itemCode = discountItemCode;
    }
    if (!discountItemCode || hutFeeMapping.codeExplicitlyConfigured || incomeCode !== "200") {
      discountLineItem.accountCode = incomeCode;
    }
    lineItems.push(discountLineItem);
  }

  const buildInvoice = (resolvedContactId: string): Invoice => ({
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: resolvedContactId },
    lineItems,
    date: getBookingInvoiceIssueDate(booking),
    dueDate: getBookingInvoiceDueDate(booking),
    reference: `Booking ${bookingId.slice(0, 8)}`,
    status: Invoice.StatusEnum.AUTHORISED,
    lineAmountTypes: LineAmountTypes.Inclusive,
  });

  const invoiceIdempotencyKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "invoice",
    "v1"
  );
  let operationId = options?.syncOperationId ?? null;
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
      localModel: "Payment",
      localId: booking.payment.id,
      idempotencyKey: invoiceIdempotencyKey,
      correlationKey: invoiceIdempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: booking.memberId,
      currentContactId: contactId,
      workflow: "createXeroInvoiceForBooking",
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
            workflow: "createXeroInvoiceForBooking",
            context: `createInvoices(booking ${bookingId})`,
          }
        ),
    });

    const createdInvoice = response.body.invoices?.[0];
    if (!createdInvoice?.invoiceID) {
      throw new Error("Failed to create Xero invoice");
    }

    // Record payment against the invoice in Xero when real funds moved.
    // Xero already marks zero-total invoices as PAID and rejects $0 payments.
    let paymentResponseBody: XeroPayment | null = null;
    let paymentWriteError: unknown = null;
    const paymentSkipped = booking.payment.status === "SUCCEEDED" && booking.payment.amountCents === 0;

    if (booking.payment.status === "SUCCEEDED" && booking.payment.amountCents > 0) {
      const payment: XeroPayment = {
        invoice: { invoiceID: createdInvoice.invoiceID },
        account: { code: bankCode },
        amount: booking.payment.amountCents / 100,
        date: formatDate(new Date()),
        reference: `Stripe ${booking.payment.stripePaymentIntentId ?? "payment"}`,
      };
      const paymentIdempotencyKey = buildXeroIdempotencyKey(
        "payment",
        booking.payment.id,
        "invoice-payment",
        "v1"
      );

      try {
        const paymentResponse = await callXeroApi(
          () =>
            xero.accountingApi.createPayment(
              tenantId,
              payment,
              paymentIdempotencyKey
            ),
          {
            operation: "createPayment",
            resourceType: "PAYMENT",
            workflow: "createXeroInvoiceForBooking",
            context: `createPayment(booking ${bookingId})`,
          }
        );
        paymentResponseBody = paymentResponse.body;
      } catch (error) {
        paymentWriteError = error;
        logger.warn(
          { err: error, bookingId, invoiceId: createdInvoice.invoiceID },
          "Created Xero invoice but failed to record the corresponding Xero payment"
        );
      }
    } else if (paymentSkipped) {
      logger.info(
        { bookingId, invoiceId: createdInvoice.invoiceID },
        "Skipping Xero payment recording for zero-total booking invoice"
      );
    }

    // Store the Xero invoice ID and number on the payment record
    await prisma.payment.update({
      where: { id: booking.payment.id },
      data: {
        xeroInvoiceId: createdInvoice.invoiceID,
        xeroInvoiceNumber: createdInvoice.invoiceNumber ?? null,
      },
    });

    await completeXeroSyncOperation(operationId!, {
      status: paymentWriteError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        invoice: response.body,
        payment: paymentResponseBody,
        paymentError: paymentWriteError,
        paymentSkipped,
        paymentSkipReason: paymentSkipped
          ? "Zero-total invoice does not require Xero payment recording."
          : null,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: createdInvoice.invoiceID,
      xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
      extraLinks: [
        {
          localModel: "Payment",
          localId: booking.payment.id,
          xeroObjectType: "INVOICE",
          xeroObjectId: createdInvoice.invoiceID,
          xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
          role: "PRIMARY_INVOICE",
        },
        ...(paymentResponseBody?.paymentID
          ? [
              {
                localModel: "Payment",
                localId: booking.payment.id,
                xeroObjectType: "PAYMENT",
                xeroObjectId: paymentResponseBody.paymentID,
                xeroObjectNumber: paymentResponseBody.invoiceNumber ?? null,
                role: "INVOICE_PAYMENT",
                metadata: {
                  invoiceId: createdInvoice.invoiceID,
                  amount: paymentResponseBody.amount ?? booking.payment.amountCents / 100,
                },
              },
            ]
          : []),
      ],
    });

    return createdInvoice.invoiceID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

function copyMutableLineItemFields(lineItem: LineItem): LineItem {
  const next: LineItem = {};

  if (lineItem.lineItemID) next.lineItemID = lineItem.lineItemID;
  if (lineItem.description) next.description = lineItem.description;
  if (typeof lineItem.quantity === "number") next.quantity = lineItem.quantity;
  if (typeof lineItem.unitAmount === "number") next.unitAmount = lineItem.unitAmount;
  if (lineItem.itemCode) next.itemCode = lineItem.itemCode;
  if (lineItem.accountCode) next.accountCode = lineItem.accountCode;
  if (lineItem.taxType) next.taxType = lineItem.taxType;
  if (typeof lineItem.taxAmount === "number") next.taxAmount = lineItem.taxAmount;
  if (typeof lineItem.lineAmount === "number") next.lineAmount = lineItem.lineAmount;
  if (lineItem.tracking) next.tracking = lineItem.tracking;
  if (typeof lineItem.discountRate === "number") next.discountRate = lineItem.discountRate;
  if (typeof lineItem.discountAmount === "number") next.discountAmount = lineItem.discountAmount;

  return next;
}

function mergeBookingInvoiceLineItemDescriptions(
  existingLineItems: LineItem[],
  desiredGuestLineItems: LineItem[],
  checkIn: Date,
  checkOut: Date,
  nights: number
): LineItem[] {
  const stayNarration = `${nights} night${nights !== 1 ? "s" : ""} - ${formatDate(checkIn)} - ${formatDate(checkOut)}`;
  let guestLineIndex = 0;

  return existingLineItems.map((existingLineItem) => {
    const nextLineItem = copyMutableLineItemFields(existingLineItem);
    const description = existingLineItem.description ?? "";

    if (description.trim().toLowerCase() === "discount") {
      return nextLineItem;
    }

    const desiredLineItem = desiredGuestLineItems[guestLineIndex];
    guestLineIndex += 1;

    if (desiredLineItem?.description) {
      nextLineItem.description = desiredLineItem.description;
      return nextLineItem;
    }

    const dateSuffixPattern = / - \d+ nights? - \d{4}-\d{2}-\d{2} - \d{4}-\d{2}-\d{2}$/;
    if (description && dateSuffixPattern.test(description)) {
      nextLineItem.description = description.replace(dateSuffixPattern, ` - ${stayNarration}`);
    }

    return nextLineItem;
  });
}

function readXeroAmount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getPrimaryInvoiceUpdateSkipReason(invoice: Invoice): string | null {
  const amountPaid = readXeroAmount(invoice.amountPaid);
  const amountCredited = readXeroAmount(invoice.amountCredited);
  const status = String(invoice.status ?? "").toUpperCase();

  if (amountPaid > 0 || status === "PAID" || invoice.fullyPaidOnDate) {
    return "Skipped primary Xero invoice update because the invoice has payment applied.";
  }

  if (amountCredited > 0) {
    return "Skipped primary Xero invoice update because the invoice has credit applied.";
  }

  if (status === "VOIDED" || status === "DELETED") {
    return `Skipped primary Xero invoice update because the invoice status is ${status}.`;
  }

  return null;
}

export async function updateXeroBookingInvoiceForBooking(
  bookingId: string,
  options?: UpdateXeroBookingInvoiceOptions
): Promise<string | null> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      guests: true,
      payment: true,
    },
  });

  if (!booking) throw new Error(`Booking not found: ${bookingId}`);
  if (!booking.payment) throw new Error(`No payment record for booking: ${bookingId}`);

  const invoiceId = booking.payment.xeroInvoiceId;
  if (!invoiceId) {
    if (options?.syncOperationId) {
      await completeXeroSyncOperation(options.syncOperationId, {
        responsePayload: {
          skipped: true,
          reason: "No original Xero invoice exists for this booking.",
        },
      });
    }
    return null;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const [hutFeeMapping, hutFeeItemCodeMap] = await Promise.all([
    getResolvedAccountMapping("hutFeesIncome"),
    getHutFeeItemCodeMap(),
  ]);
  const incomeCode = hutFeeMapping.code ?? "200";
  const checkIn = new Date(booking.checkIn);
  const checkOut = new Date(booking.checkOut);
  const nights = getStayNights(checkIn, checkOut).length;

  let bookingSeasonType: string | null = null;
  const season = await prisma.season.findFirst({
    where: {
      startDate: { lte: checkIn },
      endDate: { gte: checkIn },
      active: true,
    },
    select: { type: true },
  });
  if (season) {
    bookingSeasonType = season.type;
  }

  const desiredGuestLineItems = buildInvoiceLineItems(
    booking.guests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      priceCents: g.priceCents,
    })),
    checkIn,
    checkOut,
    nights,
    incomeCode,
    hutFeeMapping.itemCode,
    hutFeeMapping.codeExplicitlyConfigured,
    hutFeeItemCodeMap.size > 0 ? hutFeeItemCodeMap : undefined,
    bookingSeasonType,
  );

  const invoiceUpdateIdempotencyKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "invoice-update",
    invoiceId,
    formatDate(checkIn),
    formatDate(checkOut),
    "v1"
  );

  let operationId = options?.syncOperationId ?? null;
  if (!operationId) {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModel: "Payment",
      localId: booking.payment.id,
      idempotencyKey: invoiceUpdateIdempotencyKey,
      correlationKey: invoiceUpdateIdempotencyKey,
      requestPayload: {
        bookingId,
        invoiceId,
      },
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const currentInvoiceResponse = await callXeroApi(
      () => xero.accountingApi.getInvoice(tenantId, invoiceId),
      {
        operation: "getInvoice",
        resourceType: "INVOICE",
        workflow: "updateXeroBookingInvoiceForBooking",
        context: `getInvoice(booking ${bookingId})`,
      }
    );
    const currentInvoice = currentInvoiceResponse.body.invoices?.[0];
    if (!currentInvoice) {
      throw new Error(`Xero invoice not found: ${invoiceId}`);
    }
    if (!currentInvoice.contact) {
      throw new Error(`Xero invoice ${invoiceId} is missing its contact.`);
    }

    const skipReason = getPrimaryInvoiceUpdateSkipReason(currentInvoice);
    if (skipReason) {
      await completeXeroSyncOperation(operationId, {
        responsePayload: {
          skipped: true,
          reason: skipReason,
          previousInvoice: currentInvoiceResponse.body,
          bookingId,
          invoiceId,
        },
        xeroObjectType: "INVOICE",
        xeroObjectId: invoiceId,
        xeroObjectNumber: currentInvoice.invoiceNumber ?? null,
        xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
        extraLinks: [
          {
            localModel: "Payment",
            localId: booking.payment.id,
            xeroObjectType: "INVOICE",
            xeroObjectId: invoiceId,
            xeroObjectNumber: currentInvoice.invoiceNumber ?? null,
            xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
            role: "PRIMARY_INVOICE",
          },
        ],
      });

      return invoiceId;
    }

    const currentLineItems = currentInvoice.lineItems ?? [];
    if (currentLineItems.length === 0) {
      throw new Error(`Xero invoice ${invoiceId} has no line items to update safely.`);
    }

    const updatedInvoice: Invoice = {
      type: currentInvoice.type ?? Invoice.TypeEnum.ACCREC,
      contact: currentInvoice.contact,
      lineItems: mergeBookingInvoiceLineItemDescriptions(
        currentLineItems,
        desiredGuestLineItems,
        checkIn,
        checkOut,
        nights
      ),
      date: getBookingInvoiceIssueDate(booking),
      dueDate: getBookingInvoiceDueDate(booking),
      reference: currentInvoice.reference ?? `Booking ${bookingId.slice(0, 8)}`,
      invoiceNumber: currentInvoice.invoiceNumber,
      lineAmountTypes: currentInvoice.lineAmountTypes ?? LineAmountTypes.Inclusive,
    };
    const requestPayload: Invoices = { invoices: [updatedInvoice] };

    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        requestPayload: sanitizeForJson({
          ...requestPayload,
          bookingId,
          invoiceId,
        }),
      },
    });

    const response = await callXeroApi(
      () =>
        xero.accountingApi.updateInvoice(
          tenantId,
          invoiceId,
          requestPayload,
          undefined,
          invoiceUpdateIdempotencyKey
        ),
      {
        operation: "updateInvoice",
        resourceType: "INVOICE",
        workflow: "updateXeroBookingInvoiceForBooking",
        context: `updateInvoice(booking ${bookingId})`,
      }
    );

    const updated = response.body.invoices?.[0];
    await completeXeroSyncOperation(operationId, {
      responsePayload: {
        previousInvoice: currentInvoiceResponse.body,
        invoice: response.body,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: updated?.invoiceID ?? invoiceId,
      xeroObjectNumber: updated?.invoiceNumber ?? currentInvoice.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(updated?.invoiceID ?? invoiceId),
      extraLinks: [
        {
          localModel: "Payment",
          localId: booking.payment.id,
          xeroObjectType: "INVOICE",
          xeroObjectId: updated?.invoiceID ?? invoiceId,
          xeroObjectNumber: updated?.invoiceNumber ?? currentInvoice.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(updated?.invoiceID ?? invoiceId),
          role: "PRIMARY_INVOICE",
        },
      ],
    });

    return updated?.invoiceID ?? invoiceId;
  } catch (error) {
    await failXeroSyncOperation(operationId, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Credit note on refund
// ---------------------------------------------------------------------------

/**
 * Create a Xero credit note when a booking refund is processed.
 *
 * @param paymentId - The Payment record ID (not Stripe payment intent ID)
 * @param refundAmountCents - The refund amount in cents
 * @returns The Xero credit note ID
 */
export async function createXeroCreditNote(
  paymentId: string,
  refundAmountCents: number,
  options?: CreateXeroRefundCreditNoteOptions
): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      booking: {
        include: { member: true, guests: true },
      },
    },
  });

  if (!payment) throw new Error(`Payment not found: ${paymentId}`);
  if (!payment.xeroInvoiceId) {
    throw new Error(`No Xero invoice linked to payment: ${paymentId}`);
  }
  const originalInvoiceId = payment.xeroInvoiceId;
  const queuedOperationId = options?.syncOperationId ?? null;
  const canonicalRefundCreditNote = await findCanonicalPaymentRefundCreditNote(paymentId);
  const existingCreditNoteId =
    payment.xeroRefundCreditNoteId ?? canonicalRefundCreditNote?.xeroObjectId ?? null;
  const existingCreditNoteNumber =
    canonicalRefundCreditNote?.xeroObjectNumber ?? null;

  // Idempotency guard: skip if credit note already created for this payment
  if (existingCreditNoteId) {
    if (payment.xeroRefundCreditNoteId !== existingCreditNoteId) {
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          xeroRefundCreditNoteId: existingCreditNoteId,
        },
      });
    }

    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: existingCreditNoteId,
      xeroObjectNumber: existingCreditNoteNumber,
      role: "REFUND_CREDIT_NOTE",
    });
    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        responsePayload: {
          existingCreditNoteId,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: existingCreditNoteId,
        xeroObjectNumber: existingCreditNoteNumber,
        extraLinks: [
          {
            localModel: "Payment",
            localId: paymentId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: existingCreditNoteId,
            xeroObjectNumber: existingCreditNoteNumber,
            role: "REFUND_CREDIT_NOTE",
          },
        ],
      });
    }
    logger.info({ paymentId, creditNoteId: existingCreditNoteId }, "Xero credit note already exists, skipping");
    return existingCreditNoteId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Ensure the member has a Xero contact
  const contactId = await findOrCreateXeroContact(payment.booking.memberId, options);
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  const refundLineItem: LineItem = {
    description: `Refund for booking ${payment.booking.id.slice(0, 8)} (${formatDate(new Date(payment.booking.checkIn))} - ${formatDate(new Date(payment.booking.checkOut))})`,
    quantity: 1,
    unitAmount: refundAmountCents / 100,
    taxType: "OUTPUT2",
  };
  if (refundMapping.itemCode) {
    refundLineItem.itemCode = refundMapping.itemCode;
  }
  if (!refundMapping.itemCode || accountCode !== "200" || refundMapping.codeExplicitlyConfigured) {
    refundLineItem.accountCode = accountCode;
  }

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: formatDate(new Date()),
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [refundLineItem],
    reference: `Refund - Booking ${payment.booking.id.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const creditNoteIdempotencyKey = buildXeroIdempotencyKey(
    "payment",
    paymentId,
    "refund-credit-note",
    refundAmountCents,
    "v1"
  );
  let operationId = queuedOperationId;
  const requestPayload = {
    creditNotes: [buildCreditNote(contactId)],
    allocation: {
      invoiceId: originalInvoiceId,
      amount: refundAmountCents / 100,
    },
  };

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
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      idempotencyKey: creditNoteIdempotencyKey,
      correlationKey: creditNoteIdempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: payment.booking.memberId,
      currentContactId: contactId,
      workflow: "createXeroCreditNote",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
        allocation: {
          invoiceId: originalInvoiceId,
          amount: refundAmountCents / 100,
        },
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createCreditNotes(
              tenantId,
              { creditNotes: [buildCreditNote(resolvedContactId)] },
              undefined,
              undefined,
              creditNoteIdempotencyKey
            ),
          {
            operation: "createCreditNotes",
            resourceType: "CREDIT_NOTE",
            workflow: "createXeroCreditNote",
            context: `createCreditNotes(refund ${paymentId})`,
          }
        ),
    });

    const createdNote = response.body.creditNotes?.[0];
    if (!createdNote?.creditNoteID) {
      throw new Error("Failed to create Xero credit note");
    }

    // Save credit note ID immediately so follow-up retries repair the existing note instead
    // of minting duplicates when downstream bookkeeping calls fail.
    await prisma.payment.update({
      where: { id: paymentId },
      data: { xeroRefundCreditNoteId: createdNote.creditNoteID },
    });

    let refundPaymentResponseBody:
      | { paymentID?: string; invoiceNumber?: string; creditNoteNumber?: string; amount?: number }
      | null = null;
    let refundPaymentErr: unknown = null;

    try {
      const bankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
      const refundPaymentIdempotencyKey = buildXeroIdempotencyKey(
        "payment",
        paymentId,
        "refund-payment",
        refundAmountCents,
        "v1"
      );
      const refundPayment = buildRefundCreditNotePayment({
        paymentId,
        creditNoteId: createdNote.creditNoteID,
        refundAmountCents,
        bankCode,
      });
      const refundPaymentResponse = await callXeroApi(
        () =>
          xero.accountingApi.createPayments(
            tenantId,
            {
              payments: [refundPayment],
            },
            undefined,
            refundPaymentIdempotencyKey
          ),
        {
          operation: "createPayments",
          resourceType: "PAYMENT",
          workflow: "createXeroCreditNote",
          context: `createPayments(refund credit note ${paymentId})`,
        }
      );
      refundPaymentResponseBody = refundPaymentResponse.body.payments?.[0] ?? null;
      logger.info(
        { paymentId, creditNoteId: createdNote.creditNoteID },
        "Xero refund payment created against Stripe bank account via credit note"
      );
    } catch (error) {
      refundPaymentErr = error;
      logger.error(
        { err: error, paymentId, creditNoteId: createdNote.creditNoteID },
        "Failed to create Xero refund payment against Stripe bank account via credit note"
      );
    }

    await completeXeroSyncOperation(operationId!, {
      status: refundPaymentErr ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        creditNote: response.body,
        allocation: null,
        allocationSkipped: true,
        allocationSkipReason: REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON,
        refundPayment: refundPaymentResponseBody,
        refundPaymentError: refundPaymentErr,
      },
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdNote.creditNoteID,
      xeroObjectNumber: createdNote.creditNoteNumber ?? null,
      extraLinks: [
        {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNote.creditNoteID,
          xeroObjectNumber: createdNote.creditNoteNumber ?? null,
          role: "REFUND_CREDIT_NOTE",
        },
        ...(refundPaymentResponseBody?.paymentID
          ? [
              {
                localModel: "Payment",
                localId: paymentId,
                xeroObjectType: "PAYMENT",
                xeroObjectId: refundPaymentResponseBody.paymentID,
                xeroObjectNumber:
                  refundPaymentResponseBody.creditNoteNumber
                  ?? refundPaymentResponseBody.invoiceNumber
                  ?? null,
                role: "REFUND_PAYMENT",
                metadata: {
                  creditNoteId: createdNote.creditNoteID,
                  invoiceId: originalInvoiceId,
                  amountCents: refundAmountCents,
                },
              },
            ]
          : []),
      ],
    });

    return createdNote.creditNoteID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

async function backfillCancellationCreditXeroNote(params: {
  memberId: string;
  bookingId: string;
  refundAmountCents: number;
  creditNoteId: string;
}) {
  const bookingLabel = params.bookingId.slice(0, 8);
  await prisma.memberCredit.updateMany({
    where: {
      memberId: params.memberId,
      sourceBookingId: params.bookingId,
      amountCents: params.refundAmountCents,
      type: CreditType.CANCELLATION_REFUND,
      description: `Cancellation refund for booking ${bookingLabel}`,
      xeroCreditNoteId: null,
    },
    data: {
      xeroCreditNoteId: params.creditNoteId,
    },
  });
}

/**
 * Create an UNAPPLIED Xero credit note for account credit refunds.
 * Unlike createXeroCreditNote(), this:
 * - Does NOT allocate against the original invoice
 * - Does NOT create a cash refund payment
 * The credit note stays as open credit on the member's Xero contact.
 */
export async function createUnappliedXeroCreditNote(
  paymentId: string,
  refundAmountCents: number,
  options?: CreateXeroUnappliedCreditNoteOptions
): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      booking: {
        include: { member: true },
      },
    },
  });

  if (!payment) throw new Error(`Payment not found: ${paymentId}`);
  const queuedOperationId = options?.syncOperationId ?? null;
  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      role: "ACCOUNT_CREDIT_NOTE",
      active: true,
    },
    select: {
      xeroObjectId: true,
      xeroObjectNumber: true,
    },
  });

  if (existingLink?.xeroObjectId) {
    await backfillCancellationCreditXeroNote({
      memberId: payment.booking.memberId,
      bookingId: payment.booking.id,
      refundAmountCents,
      creditNoteId: existingLink.xeroObjectId,
    });

    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        responsePayload: {
          existingCreditNoteId: existingLink.xeroObjectId,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: existingLink.xeroObjectId,
        xeroObjectNumber: existingLink.xeroObjectNumber ?? null,
        extraLinks: [
          {
            localModel: "Payment",
            localId: paymentId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: existingLink.xeroObjectId,
            xeroObjectNumber: existingLink.xeroObjectNumber ?? null,
            role: "ACCOUNT_CREDIT_NOTE",
          },
        ],
      });
    }

    logger.info(
      { paymentId, creditNoteId: existingLink.xeroObjectId },
      "Xero account-credit note already exists, skipping"
    );

    return existingLink.xeroObjectId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(payment.booking.memberId, options);
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  const creditLineItem: LineItem = {
    description: `Account credit from booking ${payment.booking.id.slice(0, 8)} (${formatDate(new Date(payment.booking.checkIn))} - ${formatDate(new Date(payment.booking.checkOut))})`,
    quantity: 1,
    unitAmount: refundAmountCents / 100,
    taxType: "OUTPUT2",
  };
  if (refundMapping.itemCode) {
    creditLineItem.itemCode = refundMapping.itemCode;
  }
  if (!refundMapping.itemCode || accountCode !== "200" || refundMapping.codeExplicitlyConfigured) {
    creditLineItem.accountCode = accountCode;
  }

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: formatDate(new Date()),
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [creditLineItem],
    reference: `Account Credit - Booking ${payment.booking.id.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const idempotencyKey = buildXeroIdempotencyKey(
    "payment",
    paymentId,
    "unapplied-credit-note",
    refundAmountCents,
    "v1"
  );
  let operationId = queuedOperationId;
  const requestPayload = { creditNotes: [buildCreditNote(contactId)] };

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
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: payment.booking.memberId,
      currentContactId: contactId,
      workflow: "createUnappliedXeroCreditNote",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createCreditNotes(
              tenantId,
              { creditNotes: [buildCreditNote(resolvedContactId)] },
              undefined,
              undefined,
              idempotencyKey
            ),
          {
            operation: "createCreditNotes",
            resourceType: "CREDIT_NOTE",
            workflow: "createUnappliedXeroCreditNote",
            context: `createCreditNotes(unapplied ${paymentId})`,
          }
        ),
    });

    const createdNote = response.body.creditNotes?.[0];
    if (!createdNote?.creditNoteID) {
      throw new Error("Failed to create unapplied Xero credit note");
    }

    await backfillCancellationCreditXeroNote({
      memberId: payment.booking.memberId,
      bookingId: payment.booking.id,
      refundAmountCents,
      creditNoteId: createdNote.creditNoteID,
    });

    await completeXeroSyncOperation(operationId!, {
      responsePayload: response.body,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdNote.creditNoteID,
      xeroObjectNumber: createdNote.creditNoteNumber ?? null,
      extraLinks: [
        {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNote.creditNoteID,
          xeroObjectNumber: createdNote.creditNoteNumber ?? null,
          role: "ACCOUNT_CREDIT_NOTE",
        },
      ],
    });

    logger.info(
      { paymentId, creditNoteId: createdNote.creditNoteID },
      "Created unapplied Xero credit note for account credit"
    );

    return createdNote.creditNoteID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

/**
 * Allocate an existing Xero credit note against an invoice.
 * Used when account credit (backed by a Xero credit note) is applied to a new booking.
 */
export async function allocateCreditNoteToInvoice(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number,
  options?: {
    localModel?: string;
    localId?: string;
    role?: string;
    createdByMemberId?: string;
    syncOperationId?: string;
  }
): Promise<void> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const idempotencyKey = buildXeroIdempotencyKey(
    "credit-note",
    creditNoteId,
    "invoice",
    invoiceId,
    "allocation",
    amountCents,
    "v1"
  );
  let operationId = options?.syncOperationId ?? null;
  const requestPayload = {
    creditNoteId,
    invoiceId,
    amountCents,
  };

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
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      localModel: options?.localModel,
      localId: options?.localId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createCreditNoteAllocation(
          tenantId,
          creditNoteId,
          {
            allocations: [
              {
                invoice: { invoiceID: invoiceId },
                amount: amountCents / 100,
                date: formatDate(new Date()),
              },
            ],
          },
          undefined,
          idempotencyKey
        ),
      {
        operation: "createCreditNoteAllocation",
        resourceType: "ALLOCATION",
        workflow: "allocateCreditNoteToInvoice",
        context: `createCreditNoteAllocation(${creditNoteId} -> ${invoiceId})`,
      }
    );

    await completeXeroSyncOperation(operationId!, {
      responsePayload: response.body,
      xeroObjectType: "ALLOCATION",
      xeroObjectId: buildSyntheticAllocationId(creditNoteId, invoiceId, amountCents),
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
      extraLinks:
        options?.localModel && options.localId
          ? [
              {
                localModel: options.localModel,
                localId: options.localId,
                xeroObjectType: "ALLOCATION",
                xeroObjectId: buildSyntheticAllocationId(creditNoteId, invoiceId, amountCents),
                xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
                role: options.role ?? "CREDIT_NOTE_ALLOCATION",
                metadata: {
                  creditNoteId,
                  invoiceId,
                  amountCents,
                },
              },
            ]
          : [],
    });

    logger.info(
      { creditNoteId, invoiceId, amountCents },
      "Allocated Xero credit note against invoice"
    );
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// XER-01: Xero Invoice Adjustment on Booking Modification
// ---------------------------------------------------------------------------

/**
 * Create a supplementary Xero invoice when a booking modification increases
 * the price. Optionally includes a separate line item for a late-notice
 * change fee.
 *
 * Fire-and-forget: caller should catch errors and log them.
 */
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
export async function createXeroCreditNoteForModification(params: {
  bookingId: string;
  refundAmountCents: number;
  bookingModificationId?: string;
  createdByMemberId?: string;
  repairExistingLink?: boolean;
  syncOperationId?: string;
}): Promise<string | null> {
  const {
    bookingId,
    refundAmountCents,
    bookingModificationId,
    createdByMemberId,
    repairExistingLink,
    syncOperationId,
  } = params;

  if (refundAmountCents <= 0) {
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: {
          skipped: true,
          reason: "Refund amount is zero or negative.",
        },
      });
    }
    return null;
  }

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
  const originalInvoiceId = booking.payment.xeroInvoiceId;

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(booking.memberId, {
    createdByMemberId,
    repairExistingLink,
  });
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  const modRefundLineItem: LineItem = {
    description: `Booking modification refund (Booking ${bookingId.slice(0, 8)})`,
    quantity: 1,
    unitAmount: refundAmountCents / 100,
    taxType: "OUTPUT2",
  };
  if (refundMapping.itemCode) {
    modRefundLineItem.itemCode = refundMapping.itemCode;
  }
  if (!refundMapping.itemCode || accountCode !== "200" || refundMapping.codeExplicitlyConfigured) {
    modRefundLineItem.accountCode = accountCode;
  }

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: formatDate(new Date()),
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [modRefundLineItem],
    reference: `Modification refund - Booking ${bookingId.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const localModel = bookingModificationId ? "BookingModification" : "Booking";
  const localId = bookingModificationId ?? bookingId;
  const creditNoteIdempotencyKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    "mod-credit-note",
    refundAmountCents,
    "v1"
  );
  let operationId = syncOperationId ?? null;
  const requestPayload = {
    creditNotes: [buildCreditNote(contactId)],
    invoiceId: originalInvoiceId,
    refundAmountCents,
  };

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
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel,
      localId,
      idempotencyKey: creditNoteIdempotencyKey,
      correlationKey: creditNoteIdempotencyKey,
      requestPayload,
      createdByMemberId: createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: booking.memberId,
      currentContactId: contactId,
      workflow: "createXeroCreditNoteForModification",
      operationId: operationId!,
      repairExistingLink,
      createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
        invoiceId: originalInvoiceId,
        refundAmountCents,
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createCreditNotes(
              tenantId,
              { creditNotes: [buildCreditNote(resolvedContactId)] },
              undefined,
              undefined,
              creditNoteIdempotencyKey
            ),
          {
            operation: "createCreditNotes",
            resourceType: "CREDIT_NOTE",
            workflow: "createXeroCreditNoteForModification",
            context: `createCreditNotes(modification ${localId})`,
          }
        ),
    });

    const created = response.body.creditNotes?.[0];
    if (!created?.creditNoteID) {
      throw new Error("Failed to create modification credit note");
    }
    const createdCreditNoteId = created.creditNoteID;

    const allocationIdempotencyKey = buildXeroIdempotencyKey(
      bookingModificationId ? "booking-mod" : "booking",
      localId,
      "mod-credit-note-allocation",
      refundAmountCents,
      "v1"
    );

    try {
      const allocationResponse = await callXeroApi(
        () =>
          xero.accountingApi.createCreditNoteAllocation(
            tenantId,
            createdCreditNoteId,
            {
              allocations: [
                {
                  invoice: { invoiceID: originalInvoiceId },
                  amount: refundAmountCents / 100,
                  date: formatDate(new Date()),
                },
              ],
            },
            undefined,
            allocationIdempotencyKey
          ),
        {
          operation: "createCreditNoteAllocation",
          resourceType: "ALLOCATION",
          workflow: "createXeroCreditNoteForModification",
          context: `createCreditNoteAllocation(modification ${localId})`,
        }
      );

      await completeXeroSyncOperation(operationId!, {
        responsePayload: {
          creditNote: response.body,
          allocation: allocationResponse.body,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: createdCreditNoteId,
        xeroObjectNumber: created.creditNoteNumber ?? null,
        extraLinks: [
          {
            localModel,
            localId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: createdCreditNoteId,
            xeroObjectNumber: created.creditNoteNumber ?? null,
            role: "MODIFICATION_CREDIT_NOTE",
          },
          {
            localModel,
            localId,
            xeroObjectType: "ALLOCATION",
            xeroObjectId: buildSyntheticAllocationId(
              createdCreditNoteId,
              originalInvoiceId,
              refundAmountCents
            ),
            xeroObjectUrl: buildXeroInvoiceUrl(originalInvoiceId),
            role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
            metadata: {
              creditNoteId: createdCreditNoteId,
              invoiceId: originalInvoiceId,
              amountCents: refundAmountCents,
            },
          },
        ],
      });

      return createdCreditNoteId;
    } catch (allocationError) {
      await completeXeroSyncOperation(operationId!, {
        status: "PARTIAL",
        responsePayload: {
          creditNote: response.body,
          allocationError,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: createdCreditNoteId,
        xeroObjectNumber: created.creditNoteNumber ?? null,
        extraLinks: [
          {
            localModel,
            localId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: createdCreditNoteId,
            xeroObjectNumber: created.creditNoteNumber ?? null,
            role: "MODIFICATION_CREDIT_NOTE",
          },
        ],
      });
      throw allocationError;
    }
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Entrance Fee Invoice
// ---------------------------------------------------------------------------

/**
 * Create a Xero invoice for a membership entrance fee.
 * Called when an admin creates a new member (if Xero is connected and entrance fee is configured).
 *
 * Uses the granular per-category entrance fee mappings (XeroItemCodeMapping) when available,
 * falling back to the legacy flat entranceFeeAmountCents/entranceFeeItem from XeroAccountMapping.
 *
 * @param memberId - The member to invoice
 * @returns The Xero invoice ID, or null if entrance fee is not configured or Xero is not connected
 */
export async function createXeroEntranceFeeInvoice(
  memberId: string,
  options?: CreateXeroEntranceFeeInvoiceOptions
): Promise<string | null> {
  const entranceFee = options?.precomputedEntranceFee ?? (await getEntranceFeeContext(memberId));
  const { category, feeMapping } = entranceFee;
  const queuedOperationId = options?.syncOperationId ?? null;

  if (!feeMapping.amountCents || feeMapping.amountCents <= 0) {
    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        status: "SUCCEEDED",
        responsePayload: {
          skipped: true,
          reason: "No entrance fee is configured for this member category.",
          category,
        },
      });
    }

    return null;
  }

  // Check Xero connectivity
  let xero: XeroClient | null = null;
  let tenantId: string | null = null;
  if (!queuedOperationId) {
    try {
      ({ xero, tenantId } = await getAuthenticatedXeroClient());
    } catch {
      // Xero not connected — skip silently on direct write paths.
      return null;
    }
  }

  const categoryLabel = category === "FAMILY" ? "Family" : category === "YOUTH" ? "Youth" : category === "CHILD" ? "Child" : "Adult";
  const idempotencyKey = buildEntranceFeeInvoiceIdempotencyKey(
    memberId,
    category,
    feeMapping.amountCents
  );
  let operationId = queuedOperationId;

  try {
    if (!xero || !tenantId) {
      ({ xero, tenantId } = await getAuthenticatedXeroClient());
    }
    const authenticatedXero = xero;
    const authenticatedTenantId = tenantId;

    const contactId = await findOrCreateXeroContact(memberId, options);
    const incomeMapping = await getResolvedAccountMapping("hutFeesIncome");
    const incomeCode = incomeMapping.code ?? "200";

    const lineItem = buildEntranceFeeLineItem(
      categoryLabel,
      feeMapping.amountCents,
      incomeCode,
      feeMapping.itemCode,
      incomeMapping.codeExplicitlyConfigured,
      entranceFee.description,
    );

    const buildInvoice = (resolvedContactId: string): Invoice => ({
      type: Invoice.TypeEnum.ACCREC,
      contact: { contactID: resolvedContactId },
      lineItems: [lineItem],
      date: formatDate(new Date()),
      dueDate: formatDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)), // Due in 30 days
      reference: `Entrance fee (${categoryLabel}) - ${memberId.slice(0, 8)}`,
      status: Invoice.StatusEnum.AUTHORISED,
      lineAmountTypes: LineAmountTypes.Inclusive,
    });

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
        localModel: "Member",
        localId: memberId,
        idempotencyKey,
        correlationKey: idempotencyKey,
        requestPayload,
        createdByMemberId: options?.createdByMemberId ?? null,
      });
      operationId = operation.id;
    }

    const response = await retryXeroWriteWithContactRepair({
      memberId,
      currentContactId: contactId,
      workflow: "createXeroEntranceFeeInvoice",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        invoices: [buildInvoice(resolvedContactId)],
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            authenticatedXero.accountingApi.createInvoices(
              authenticatedTenantId,
              { invoices: [buildInvoice(resolvedContactId)] },
              undefined,
              undefined,
              idempotencyKey
            ),
          {
            operation: "createInvoices",
            resourceType: "INVOICE",
            workflow: "createXeroEntranceFeeInvoice",
            context: `createInvoices(entranceFee ${memberId})`,
          }
        ),
    });

    const created = response.body.invoices?.[0];
    if (!created?.invoiceID) {
      throw new Error("Failed to create Xero entrance fee invoice");
    }

    await completeXeroSyncOperation(operationId!, {
      responsePayload: response.body,
      xeroObjectType: "INVOICE",
      xeroObjectId: created.invoiceID,
      xeroObjectNumber: created.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
      extraLinks: [
        {
          localModel: "Member",
          localId: memberId,
          xeroObjectType: "INVOICE",
          xeroObjectId: created.invoiceID,
          xeroObjectNumber: created.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
          role: "ENTRANCE_FEE_INVOICE",
          metadata: {
            category,
            feeAmountCents: feeMapping.amountCents,
            description: entranceFee.description ?? null,
          },
        },
      ],
    });

    logger.info(
      { memberId, category, invoiceId: created.invoiceID, feeAmountCents: feeMapping.amountCents },
      "Created Xero entrance fee invoice"
    );

    return created.invoiceID;
  } catch (error) {
    if (operationId) {
      await failXeroSyncOperation(operationId, error);
    }
    throw error;
  }
}

