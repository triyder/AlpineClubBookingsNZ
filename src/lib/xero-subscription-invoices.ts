import {
  Invoice,
  LineAmountTypes,
  RequestEmpty,
  type XeroClient,
} from "xero-node";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { findOrCreateXeroContact } from "@/lib/xero-contacts";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { formatDate } from "@/lib/xero-invoice-helpers";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import { XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function invoiceCents(invoice: Invoice) {
  if (typeof invoice.total === "number") return Math.round(invoice.total * 100);
  return Math.round((invoice.lineItems ?? []).reduce((sum, line) =>
    sum + (line.lineAmount ?? ((line.quantity ?? 1) * (line.unitAmount ?? 0))), 0) * 100);
}

function normalizeXeroDateOnly(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDate(value);
  }
  if (typeof value !== "string") return null;
  const dateOnly = value.match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/)?.[1];
  if (dateOnly) return dateOnly;
  const microsoftJsonMs = value.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/)?.[1];
  if (!microsoftJsonMs) return null;
  const parsed = new Date(Number(microsoftJsonMs));
  return Number.isNaN(parsed.getTime()) ? null : formatDate(parsed);
}

function invoiceDueIntervalDays(invoice: Invoice): number | null {
  const issueDate = normalizeXeroDateOnly(invoice.date);
  const dueDate = normalizeXeroDateOnly(invoice.dueDate);
  if (!issueDate || !dueDate) return null;
  const issueMs = Date.parse(`${issueDate}T00:00:00.000Z`);
  const dueMs = Date.parse(`${dueDate}T00:00:00.000Z`);
  return (dueMs - issueMs) / (24 * 60 * 60 * 1000);
}

// One expected invoice line derived from a frozen charge-component snapshot.
export type SubscriptionInvoiceLine = {
  amountCents: number;
  accountCode: string;
  itemCode: string | null;
};

function lineCents(line: NonNullable<Invoice["lineItems"]>[number]) {
  const amount = line.lineAmount ?? ((line.quantity ?? 1) * (line.unitAmount ?? 0));
  return Math.round(amount * 100);
}

// Adoption/idempotency guard (#1932, E6): the immutable charge now snapshots one
// component per invoice line, so the match compares the FULL line array in order
// (count, per-line amount + account + item + OUTPUT2 tax) plus the invoice-level
// total, reference, contact, due interval, type, line-amount type and status.
// A legacy single-line invoice adopts against a backfilled single-component
// charge because that charge reproduces exactly one line. Line description is
// deliberately NOT compared — it is derived at build time and must not make a
// pre-existing AUTHORISED invoice fail to adopt.
export function subscriptionInvoiceMatchesSnapshot(input: {
  invoice: Invoice;
  contactId: string;
  amountCents: number;
  lines: SubscriptionInvoiceLine[];
  dueDays: number;
  reference: string;
}) {
  const { invoice, contactId, amountCents, lines, dueDays, reference } = input;
  const invoiceLines = invoice.lineItems ?? [];
  return invoice.reference === reference
    && invoice.contact?.contactID === contactId
    && invoiceCents(invoice) === amountCents
    && invoiceLines.length === lines.length
    && lines.every((line, index) =>
      lineCents(invoiceLines[index]) === line.amountCents
      && invoiceLines[index]?.accountCode === line.accountCode
      && (invoiceLines[index]?.itemCode ?? null) === line.itemCode
      && invoiceLines[index]?.taxType === "OUTPUT2")
    && invoiceDueIntervalDays(invoice) === dueDays
    && invoice.type === Invoice.TypeEnum.ACCREC
    && invoice.lineAmountTypes === LineAmountTypes.Inclusive
    && invoice.status === Invoice.StatusEnum.AUTHORISED;
}

export async function enqueueMembershipSubscriptionChargeOperation(
  chargeId: string,
  options?: { createdByMemberId?: string },
) {
  const charge = await prisma.membershipSubscriptionCharge.findUnique({
    where: { id: chargeId },
    select: { id: true, status: true, billingBasis: true, xeroInvoiceId: true, emailSentAt: true },
  });
  if (!charge) throw new Error(`Membership subscription charge not found: ${chargeId}`);
  if (charge.billingBasis === "NO_INVOICE" || charge.status === "NOT_REQUIRED" || charge.emailSentAt) {
    return { queueOperationId: null, message: "No subscription invoice work is required." };
  }
  const correlationKey = buildXeroIdempotencyKey("membership-charge", chargeId, "invoice-and-email", "v1");
  const active = await prisma.xeroSyncOperation.findFirst({
    where: { correlationKey, status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (active) return { queueOperationId: active.id, message: "Subscription invoice is already queued." };
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "MembershipSubscriptionCharge",
    localId: chargeId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: { queueType: XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE, chargeId },
    createdByMemberId: options?.createdByMemberId ?? null,
  });
  await prisma.membershipSubscriptionCharge.update({
    where: { id: chargeId },
    data: { status: charge.xeroInvoiceId ? "INVOICE_CREATED" : "QUEUED", lastErrorCode: null, lastErrorMessage: null },
  });
  return { queueOperationId: operation.id, message: "Subscription invoice queued." };
}

async function findExistingByReference(
  xero: XeroClient,
  tenantId: string,
  reference: string,
) {
  const response = await callXeroApi(
    () => xero.accountingApi.getInvoices(
      tenantId,
      undefined,
      `Reference==\"${reference}\"`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      false,
    ),
    {
      operation: "getInvoices",
      resourceType: "INVOICE",
      workflow: "createXeroMembershipSubscriptionInvoice",
      context: `find subscription invoice ${reference}`,
    },
  );
  return response.body.invoices ?? [];
}

export async function createXeroMembershipSubscriptionInvoice(input: {
  chargeId: string;
  syncOperationId: string;
  createdByMemberId?: string;
}) {
  const charge = await prisma.membershipSubscriptionCharge.findUnique({
    where: { id: input.chargeId },
    include: {
      coverage: {
        include: {
          subscription: {
            select: { id: true, status: true, manuallyMarkedPaidAt: true },
          },
        },
      },
      components: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
    },
  });
  if (!charge) throw new Error(`Membership subscription charge not found: ${input.chargeId}`);
  if (charge.billingBasis === "NO_INVOICE") {
    await completeXeroSyncOperation(input.syncOperationId, { responsePayload: { skipped: true, reason: "NO_INVOICE" } });
    return null;
  }

  // #1944 non-clobber guard: a charge can sit QUEUED (or retry for days) while
  // a treasurer manually marks the covered subscription paid (cash outside
  // Xero). Minting an invoice then would double-bill and the coverage write
  // below would downgrade the PAID row to UNPAID. If any covered subscription
  // is already PAID before an invoice exists, stop and surface a billing
  // exception instead (same CONFLICT pattern as the adoption guards). Once an
  // invoice has been minted (charge.xeroInvoiceId set) the resume path
  // continues as before; the status-fenced updateMany below still refuses to
  // downgrade a PAID row.
  if (!charge.xeroInvoiceId) {
    const alreadyPaid = charge.coverage.filter((row) => row.subscription.status === "PAID");
    if (alreadyPaid.length > 0) {
      await prisma.membershipSubscriptionCharge.update({
        where: { id: charge.id },
        data: {
          status: "CONFLICT",
          lastErrorCode: "SUBSCRIPTION_ALREADY_PAID",
          lastErrorMessage: `Covered subscription${alreadyPaid.length === 1 ? " is" : "s are"} already PAID (${alreadyPaid.map((row) => row.memberName).join(", ")}); no Xero invoice was created. Reverse the manual payment or resolve the charge.`,
        },
      });
      await completeXeroSyncOperation(input.syncOperationId, {
        status: "SUCCEEDED",
        responsePayload: {
          conflict: "SUBSCRIPTION_ALREADY_PAID",
          subscriptionIds: alreadyPaid.map((row) => row.subscription.id),
          manuallyMarkedPaid: alreadyPaid.some((row) => Boolean(row.subscription.manuallyMarkedPaidAt)),
        },
      });
      return null;
    }
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(charge.recipientMemberId, {
    createdByMemberId: input.createdByMemberId,
  });
  const accountCode = charge.xeroAccountCode;
  if (!accountCode) {
    await prisma.membershipSubscriptionCharge.update({
      where: { id: charge.id },
      data: {
        status: "CONFLICT",
        lastErrorCode: "MISSING_MAPPING_SNAPSHOT",
        lastErrorMessage: "This charge has no immutable subscriptionIncome account mapping snapshot.",
      },
    });
    await completeXeroSyncOperation(input.syncOperationId, {
      status: "SUCCEEDED",
      responsePayload: { conflict: "MISSING_MAPPING_SNAPSHOT" },
    });
    return null;
  }

  // One invoice line per frozen component snapshot (#1932, E6), in stable order.
  // The synthetic fallback reproduces the identical historical single line for
  // any invoiceable charge minted before the component backfill — the exact same
  // derivation the backfill used — so there is one line shape forever.
  const componentLines = charge.components.length > 0
    ? charge.components.map((component) => ({
        amountCents: component.chargedAmountCents,
        accountCode: component.xeroAccountCode,
        itemCode: component.xeroItemCode,
        description: component.description,
      }))
    : [{
        amountCents: charge.chargedAmountCents,
        accountCode,
        itemCode: charge.xeroItemCode,
        description: `${charge.membershipTypeName} membership ${charge.seasonYear}/${charge.seasonYear + 1} (${charge.coveredMonths} month${charge.coveredMonths === 1 ? "" : "s"})`,
      }];

  let invoiceId = charge.xeroInvoiceId;
  let invoiceNumber = charge.xeroInvoiceNumber;
  let adopted = charge.xeroInvoiceAdopted;
  let providerInvoice: Invoice | null = null;
  if (!invoiceId) {
    const existing = await findExistingByReference(xero, tenantId, charge.invoiceReference);
    if (existing.length > 1) {
      await prisma.membershipSubscriptionCharge.update({
        where: { id: charge.id },
        data: { status: "CONFLICT", lastErrorCode: "DUPLICATE_REFERENCE", lastErrorMessage: "More than one Xero invoice has this immutable subscription reference." },
      });
      await completeXeroSyncOperation(input.syncOperationId, { status: "SUCCEEDED", responsePayload: { conflict: "DUPLICATE_REFERENCE", invoiceCount: existing.length } });
      return null;
    }
    if (existing[0]) {
      if (!subscriptionInvoiceMatchesSnapshot({
        invoice: existing[0], contactId, amountCents: charge.chargedAmountCents,
        lines: componentLines.map(({ amountCents, accountCode: code, itemCode }) => ({ amountCents, accountCode: code, itemCode })),
        dueDays: charge.dueDays, reference: charge.invoiceReference,
      })) {
        await prisma.membershipSubscriptionCharge.update({
          where: { id: charge.id },
          data: { status: "CONFLICT", lastErrorCode: "PROVIDER_MISMATCH", lastErrorMessage: "The existing Xero invoice does not match the immutable charge snapshot. It was not changed." },
        });
        await completeXeroSyncOperation(input.syncOperationId, { status: "SUCCEEDED", responsePayload: { conflict: "PROVIDER_MISMATCH", invoice: existing[0] } });
        return null;
      }
      providerInvoice = existing[0];
      invoiceId = existing[0].invoiceID ?? null;
      invoiceNumber = existing[0].invoiceNumber ?? null;
      adopted = true;
    } else {
      const issueDate = new Date();
      const built: Invoice = {
        type: Invoice.TypeEnum.ACCREC,
        contact: { contactID: contactId },
        lineItems: componentLines.map((line) => ({
          quantity: 1,
          unitAmount: line.amountCents / 100,
          accountCode: line.accountCode,
          ...(line.itemCode ? { itemCode: line.itemCode } : {}),
          description: line.description,
          taxType: "OUTPUT2",
        })),
        date: formatDate(issueDate),
        dueDate: formatDate(addUtcDays(issueDate, charge.dueDays)),
        reference: charge.invoiceReference,
        status: Invoice.StatusEnum.AUTHORISED,
        lineAmountTypes: LineAmountTypes.Inclusive,
      };
      const idempotencyKey = buildXeroIdempotencyKey("membership-charge", charge.id, "invoice", "v1");
      const response = await callXeroApi(
        () => xero.accountingApi.createInvoices(tenantId, { invoices: [built] }, undefined, undefined, idempotencyKey),
        {
          operation: "createInvoices", resourceType: "INVOICE",
          workflow: "createXeroMembershipSubscriptionInvoice",
          context: `create subscription invoice ${charge.id}`,
        },
      );
      providerInvoice = response.body.invoices?.[0] ?? null;
      invoiceId = providerInvoice?.invoiceID ?? null;
      invoiceNumber = providerInvoice?.invoiceNumber ?? null;
    }
  }
  if (!invoiceId) throw new Error("Xero did not return an invoice identifier for the subscription charge.");

  // Durably record creation/adoption before attempting Xero email. A crash or
  // email failure now resumes from this identifier and cannot mint a duplicate.
  await prisma.$transaction(async (tx) => {
    await tx.membershipSubscriptionCharge.update({
      where: { id: charge.id },
      data: {
        status: "INVOICE_CREATED",
        xeroInvoiceId: invoiceId,
        xeroInvoiceNumber: invoiceNumber,
        xeroInvoiceUrl: buildXeroInvoiceUrl(invoiceId),
        xeroInvoiceAdopted: adopted,
        invoicePersistedAt: charge.invoicePersistedAt ?? new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    // #1944: never blind-downgrade a PAID subscription (e.g. manually marked
    // paid between the guard above and this transaction). Skipped rows keep
    // their PAID status and manual provenance; the invoice link is still
    // recorded on the charge and object links for the admin to reconcile.
    const downgraded = await tx.memberSubscription.updateMany({
      where: {
        id: { in: charge.coverage.map((row) => row.subscription.id) },
        status: { not: "PAID" },
      },
      data: { status: "UNPAID", xeroInvoiceId: invoiceId, xeroInvoiceNumber: invoiceNumber },
    });
    if (downgraded.count < charge.coverage.length) {
      logger.warn(
        { chargeId: charge.id, invoiceId, updated: downgraded.count, covered: charge.coverage.length },
        "Subscription invoice created but one or more covered subscriptions were already PAID and were not downgraded",
      );
    }
    for (const covered of charge.coverage) {
      await tx.xeroObjectLink.upsert({
        where: {
          localModel_localId_xeroObjectType_xeroObjectId_role: {
            localModel: "MemberSubscription", localId: covered.subscription.id,
            xeroObjectType: "SUBSCRIPTION", xeroObjectId: invoiceId, role: "SUBSCRIPTION_INVOICE",
          },
        },
        update: { active: true, xeroObjectNumber: invoiceNumber, xeroObjectUrl: buildXeroInvoiceUrl(invoiceId), metadata: { seasonYear: charge.seasonYear } },
        create: {
          localModel: "MemberSubscription", localId: covered.subscription.id,
          xeroObjectType: "SUBSCRIPTION", xeroObjectId: invoiceId,
          xeroObjectNumber: invoiceNumber, xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
          role: "SUBSCRIPTION_INVOICE", metadata: { seasonYear: charge.seasonYear },
        },
      });
    }
    await tx.xeroObjectLink.upsert({
      where: {
        localModel_localId_xeroObjectType_xeroObjectId_role: {
          localModel: "MembershipSubscriptionCharge", localId: charge.id,
          xeroObjectType: "INVOICE", xeroObjectId: invoiceId, role: "SUBSCRIPTION_INVOICE",
        },
      },
      update: { active: true, xeroObjectNumber: invoiceNumber, xeroObjectUrl: buildXeroInvoiceUrl(invoiceId), metadata: { adopted } },
      create: {
        localModel: "MembershipSubscriptionCharge", localId: charge.id,
        xeroObjectType: "INVOICE", xeroObjectId: invoiceId, xeroObjectNumber: invoiceNumber,
        xeroObjectUrl: buildXeroInvoiceUrl(invoiceId), role: "SUBSCRIPTION_INVOICE", metadata: { adopted },
      },
    });
  });

  const emailIdempotencyKey = buildXeroIdempotencyKey("membership-charge", charge.id, "invoice-email", invoiceId, "v1");
  try {
    const response = await callXeroApi(
      () => xero.accountingApi.emailInvoice(tenantId, invoiceId!, new RequestEmpty(), emailIdempotencyKey),
      {
        operation: "emailInvoice", resourceType: "INVOICE",
        workflow: "createXeroMembershipSubscriptionInvoice",
        context: `email subscription invoice ${charge.id}`,
      },
    );
    await prisma.membershipSubscriptionCharge.update({
      where: { id: charge.id },
      data: { status: "EMAILED", emailAttemptCount: { increment: 1 }, emailLastAttemptAt: new Date(), emailSentAt: new Date(), lastErrorCode: null, lastErrorMessage: null },
    });
    await completeXeroSyncOperation(input.syncOperationId, {
      responsePayload: { invoice: providerInvoice, adopted, email: response.body ?? null },
      xeroObjectType: "INVOICE", xeroObjectId: invoiceId, xeroObjectNumber: invoiceNumber,
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: error, chargeId: charge.id, invoiceId }, "Subscription invoice persisted but Xero email failed");
    await prisma.membershipSubscriptionCharge.update({
      where: { id: charge.id },
      data: { status: "EMAIL_FAILED", emailAttemptCount: { increment: 1 }, emailLastAttemptAt: new Date(), lastErrorCode: "EMAIL_FAILED", lastErrorMessage: message },
    });
    await completeXeroSyncOperation(input.syncOperationId, {
      status: "PARTIAL", responsePayload: { invoice: providerInvoice, adopted, emailError: message },
      xeroObjectType: "INVOICE", xeroObjectId: invoiceId, xeroObjectNumber: invoiceNumber,
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
    });
  }
  return invoiceId;
}
