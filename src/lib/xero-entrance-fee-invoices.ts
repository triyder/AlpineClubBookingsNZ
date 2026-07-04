/**
 * Membership entrance-fee invoices.
 *
 * Issues a one-off Xero invoice for the categorised entrance fee that
 * applies to a new member's age tier (`Adult`, `Family`, `Youth`,
 * `Child`). Resolves the per-category amount, account code, and item
 * code through the xero-mappings layer.
 */

import {
  Invoice,
  LineAmountTypes,
  LineItem,
  type XeroClient,
} from "xero-node";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
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
  buildEntranceFeeInvoiceIdempotencyKey,
  getEntranceFeeContext,
  getResolvedAccountMapping,
  type EntranceFeeContext,
} from "./xero-mappings";
import {
  findOrCreateXeroContact,
  retryXeroWriteWithContactRepair,
  type FindOrCreateXeroContactOptions,
} from "./xero-contacts";
import { formatDate } from "./xero-invoice-helpers";

export interface CreateXeroEntranceFeeInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
  precomputedEntranceFee?: EntranceFeeContext;
}

// test seam
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

