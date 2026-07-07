import { FinanceSnapshotType, Prisma } from "@prisma/client";
import type { Invoice } from "xero-node";
import type { FinanceSyncSnapshotInput } from "@/lib/finance-sync-service";
import {
  addToAgedInvoiceTotals,
  compareNullableStrings,
  compareOpenInvoicePayloadsByDueDate,
  createEmptyAgedInvoiceTotals,
  deriveSnapshotCurrency,
  getAgedInvoiceBucket,
  getContactAccumulatorKey,
  getInvoiceAmountDue,
  getInvoiceContactName,
  getInvoiceCurrency,
  isEligibleOpenInvoice,
  updateContactDueDateRange,
} from "./invoice-helpers";
import {
  parseOptionalDateOnly,
  toDateOnlyString,
  toOptionalDate,
  toOptionalDateOnlyText,
  toOptionalText,
} from "./date-format";
import type {
  FinanceAgedInvoiceBucketKey,
  FinanceAgedInvoiceBucketTotals,
  FinanceOpenInvoiceType,
} from "./types";

type FinanceAgedSnapshotType = "AGED_RECEIVABLES" | "AGED_PAYABLES";

interface FinanceAgedInvoicePayload {
  invoiceId: string | null;
  invoiceNumber: string | null;
  reference: string | null;
  status: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  expectedPaymentDate: string | null;
  updatedDateUTC: string | null;
  currency: string;
  currencyRate: number | null;
  total: number | null;
  amountPaid: number | null;
  amountCredited: number | null;
  amountDue: number;
  bucket: FinanceAgedInvoiceBucketKey;
  daysOverdue: number | null;
}

interface FinanceAgedContactPayload {
  contactId: string | null;
  contactName: string | null;
  contactStatus: string | null;
  currency: string;
  invoiceCount: number;
  oldestDueDate: string | null;
  latestDueDate: string | null;
  totals: FinanceAgedInvoiceBucketTotals;
  invoices: FinanceAgedInvoicePayload[];
}

interface FinanceAgedCurrencyPayload {
  currency: string;
  invoiceCount: number;
  contactCount: number;
  totals: FinanceAgedInvoiceBucketTotals;
}

interface FinanceAgedSnapshotPayload {
  asOfDate: string;
  invoiceCount: number;
  contactCount: number;
  currencies: string[];
  totalsByCurrency: FinanceAgedCurrencyPayload[];
  contacts: FinanceAgedContactPayload[];
}

interface FinanceAgedContactAccumulator {
  contactId: string | null;
  contactName: string | null;
  contactStatus: string | null;
  currency: string;
  invoiceCount: number;
  oldestDueDate: Date | null;
  latestDueDate: Date | null;
  totals: FinanceAgedInvoiceBucketTotals;
  invoices: FinanceAgedInvoicePayload[];
}

interface FinanceAgedCurrencyAccumulator {
  currency: string;
  invoiceCount: number;
  contactKeys: Set<string>;
  totals: FinanceAgedInvoiceBucketTotals;
}

function buildFinanceAgedInvoiceSnapshot(input: {
  asOfDate: Date;
  invoices: Invoice[];
  invoiceType: FinanceOpenInvoiceType;
  snapshotType: FinanceAgedSnapshotType;
}): FinanceSyncSnapshotInput {
  const contacts = new Map<string, FinanceAgedContactAccumulator>();
  const totalsByCurrency = new Map<string, FinanceAgedCurrencyAccumulator>();
  let sourceUpdatedAt: Date | null = null;
  let invoiceCount = 0;

  for (const invoice of input.invoices) {
    if (!isEligibleOpenInvoice(invoice, input.asOfDate, input.invoiceType)) {
      continue;
    }

    const amountDue = getInvoiceAmountDue(invoice);
    const dueDate = parseOptionalDateOnly(invoice.dueDate);
    const { bucket, daysOverdue } = getAgedInvoiceBucket(input.asOfDate, dueDate);
    const currency = getInvoiceCurrency(invoice);
    const contactKey = getContactAccumulatorKey(invoice);
    const invoicePayload: FinanceAgedInvoicePayload = {
      invoiceId: toOptionalText(invoice.invoiceID),
      invoiceNumber: toOptionalText(invoice.invoiceNumber),
      reference: toOptionalText(invoice.reference),
      status: toOptionalText(invoice.status),
      invoiceDate: toOptionalDateOnlyText(invoice.date),
      dueDate: toOptionalDateOnlyText(invoice.dueDate),
      expectedPaymentDate: toOptionalDateOnlyText(invoice.expectedPaymentDate),
      updatedDateUTC: toOptionalDate(invoice.updatedDateUTC)?.toISOString() ?? null,
      currency,
      currencyRate:
        typeof invoice.currencyRate === "number" ? invoice.currencyRate : null,
      total: typeof invoice.total === "number" ? invoice.total : null,
      amountPaid:
        typeof invoice.amountPaid === "number" ? invoice.amountPaid : null,
      amountCredited:
        typeof invoice.amountCredited === "number" ? invoice.amountCredited : null,
      amountDue,
      bucket,
      daysOverdue,
    };

    const contactSummary =
      contacts.get(contactKey) ??
      {
        contactId: toOptionalText(invoice.contact?.contactID),
        contactName: getInvoiceContactName(invoice),
        contactStatus: toOptionalText(invoice.contact?.contactStatus),
        currency,
        invoiceCount: 0,
        oldestDueDate: null,
        latestDueDate: null,
        totals: createEmptyAgedInvoiceTotals(),
        invoices: [],
      };

    contactSummary.invoiceCount += 1;
    updateContactDueDateRange(contactSummary, dueDate);
    addToAgedInvoiceTotals(contactSummary.totals, bucket, amountDue);
    contactSummary.invoices.push(invoicePayload);
    contacts.set(contactKey, contactSummary);

    const currencySummary =
      totalsByCurrency.get(currency) ??
      {
        currency,
        invoiceCount: 0,
        contactKeys: new Set<string>(),
        totals: createEmptyAgedInvoiceTotals(),
      };

    currencySummary.invoiceCount += 1;
    currencySummary.contactKeys.add(contactKey);
    addToAgedInvoiceTotals(currencySummary.totals, bucket, amountDue);
    totalsByCurrency.set(currency, currencySummary);

    invoiceCount += 1;

    const updatedDate = toOptionalDate(invoice.updatedDateUTC);
    if (updatedDate && (!sourceUpdatedAt || updatedDate > sourceUpdatedAt)) {
      sourceUpdatedAt = updatedDate;
    }
  }

  const contactPayloads = Array.from(contacts.values())
    .map(
      (contact): FinanceAgedContactPayload => ({
        contactId: contact.contactId,
        contactName: contact.contactName,
        contactStatus: contact.contactStatus,
        currency: contact.currency,
        invoiceCount: contact.invoiceCount,
        oldestDueDate: toDateOnlyString(contact.oldestDueDate),
        latestDueDate: toDateOnlyString(contact.latestDueDate),
        totals: contact.totals,
        invoices: contact.invoices.sort((left, right) =>
          compareOpenInvoicePayloadsByDueDate(left, right)
        ),
      })
    )
    .sort((left, right) => {
      if (right.totals.total !== left.totals.total) {
        return right.totals.total - left.totals.total;
      }

      const nameOrder = compareNullableStrings(left.contactName, right.contactName);
      if (nameOrder !== 0) {
        return nameOrder;
      }

      return compareNullableStrings(left.currency, right.currency);
    });

  const currencyPayloads = Array.from(totalsByCurrency.values())
    .map(
      (currency): FinanceAgedCurrencyPayload => ({
        currency: currency.currency,
        invoiceCount: currency.invoiceCount,
        contactCount: currency.contactKeys.size,
        totals: currency.totals,
      })
    )
    .sort((left, right) => compareNullableStrings(left.currency, right.currency));

  const payload = {
    asOfDate: toDateOnlyString(input.asOfDate),
    invoiceCount,
    contactCount: contactPayloads.length,
    currencies: currencyPayloads.map((currency) => currency.currency),
    totalsByCurrency: currencyPayloads,
    contacts: contactPayloads,
  } as Prisma.InputJsonObject & FinanceAgedSnapshotPayload;

  const snapshotCurrency = deriveSnapshotCurrency(currencyPayloads);

  return {
    snapshotType: input.snapshotType,
    asOfDate: input.asOfDate,
    periodEnd: input.asOfDate,
    rowCount: contactPayloads.length,
    scope: "organisation",
    currency: snapshotCurrency,
    payload,
    sourceUpdatedAt,
  };
}

// test seam
export function buildFinanceAgedReceivablesSnapshot(input: {
  asOfDate: Date;
  invoices: Invoice[];
}): FinanceSyncSnapshotInput {
  return buildFinanceAgedInvoiceSnapshot({
    asOfDate: input.asOfDate,
    invoices: input.invoices,
    invoiceType: "ACCREC",
    snapshotType: FinanceSnapshotType.AGED_RECEIVABLES,
  });
}

// test seam
export function buildFinanceAgedPayablesSnapshot(input: {
  asOfDate: Date;
  invoices: Invoice[];
}): FinanceSyncSnapshotInput {
  return buildFinanceAgedInvoiceSnapshot({
    asOfDate: input.asOfDate,
    invoices: input.invoices,
    invoiceType: "ACCPAY",
    snapshotType: FinanceSnapshotType.AGED_PAYABLES,
  });
}
