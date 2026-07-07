import { FinanceSnapshotType, Prisma } from "@prisma/client";
import type { Invoice } from "xero-node";
import type { FinanceSyncSnapshotInput } from "@/lib/finance-sync-service";
import {
  compareNullableStrings,
  compareOpenInvoicePayloadsByDueDate,
  deriveSnapshotCurrency,
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
import type { FinanceOpenInvoiceType } from "./types";

interface FinanceAccountsReceivableInvoicePayload {
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
  subTotal: number | null;
  totalTax: number | null;
  total: number | null;
  amountPaid: number | null;
  amountCredited: number | null;
  amountDue: number;
}

interface FinanceAccountsPayableInvoicePayload {
  invoiceId: string | null;
  invoiceNumber: string | null;
  reference: string | null;
  status: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  plannedPaymentDate: string | null;
  updatedDateUTC: string | null;
  currency: string;
  currencyRate: number | null;
  subTotal: number | null;
  totalTax: number | null;
  total: number | null;
  amountPaid: number | null;
  amountCredited: number | null;
  amountDue: number;
}

interface OpenInvoicesContactAccumulator<TInvoice> {
  contactId: string | null;
  contactName: string | null;
  contactStatus: string | null;
  currency: string;
  invoiceCount: number;
  totalAmountDue: number;
  oldestDueDate: Date | null;
  latestDueDate: Date | null;
  invoices: TInvoice[];
}

interface OpenInvoicesCurrencyAccumulator {
  currency: string;
  invoiceCount: number;
  contactKeys: Set<string>;
  totalAmountDue: number;
}

interface OpenInvoicesContactPayload<TInvoice> {
  contactId: string | null;
  contactName: string | null;
  contactStatus: string | null;
  currency: string;
  invoiceCount: number;
  totalAmountDue: number;
  oldestDueDate: string | null;
  latestDueDate: string | null;
  invoices: TInvoice[];
}

interface OpenInvoicesCurrencyPayload {
  currency: string;
  invoiceCount: number;
  contactCount: number;
  totalAmountDue: number;
}

interface OpenInvoicesPayload<TInvoice> {
  asOfDate: string;
  invoiceCount: number;
  contactCount: number;
  currencies: string[];
  totalsByCurrency: OpenInvoicesCurrencyPayload[];
  contacts: OpenInvoicesContactPayload<TInvoice>[];
}

/**
 * Shared open-invoice detail builder for the accounts-receivable and
 * accounts-payable snapshots, which differ only in the per-invoice payment-date
 * field and their snapshot type. The caller supplies `buildInvoicePayload` so
 * each snapshot's persisted invoice shape stays verbatim; the contact/currency
 * accumulation, ordering, and totals are identical and live here once. Mirrors
 * the aged-invoice builder's shared helper.
 */
function buildFinanceOpenInvoicesSnapshot<
  TInvoice extends {
    dueDate: string | null;
    invoiceNumber: string | null;
    invoiceId: string | null;
  }
>(input: {
  asOfDate: Date;
  invoices: Invoice[];
  invoiceType: FinanceOpenInvoiceType;
  snapshotType: FinanceSnapshotType;
  buildInvoicePayload: (
    invoice: Invoice,
    context: { amountDue: number; currency: string }
  ) => TInvoice;
}): FinanceSyncSnapshotInput {
  const contacts = new Map<string, OpenInvoicesContactAccumulator<TInvoice>>();
  const totalsByCurrency = new Map<string, OpenInvoicesCurrencyAccumulator>();
  let sourceUpdatedAt: Date | null = null;
  let invoiceCount = 0;

  for (const invoice of input.invoices) {
    if (!isEligibleOpenInvoice(invoice, input.asOfDate, input.invoiceType)) {
      continue;
    }

    const amountDue = getInvoiceAmountDue(invoice);
    const currency = getInvoiceCurrency(invoice);
    const dueDate = parseOptionalDateOnly(invoice.dueDate);
    const contactKey = getContactAccumulatorKey(invoice);
    const invoicePayload = input.buildInvoicePayload(invoice, {
      amountDue,
      currency,
    });

    const contactSummary =
      contacts.get(contactKey) ??
      {
        contactId: toOptionalText(invoice.contact?.contactID),
        contactName: getInvoiceContactName(invoice),
        contactStatus: toOptionalText(invoice.contact?.contactStatus),
        currency,
        invoiceCount: 0,
        totalAmountDue: 0,
        oldestDueDate: null,
        latestDueDate: null,
        invoices: [],
      };

    contactSummary.invoiceCount += 1;
    contactSummary.totalAmountDue += amountDue;
    updateContactDueDateRange(contactSummary, dueDate);
    contactSummary.invoices.push(invoicePayload);
    contacts.set(contactKey, contactSummary);

    const currencySummary =
      totalsByCurrency.get(currency) ??
      {
        currency,
        invoiceCount: 0,
        contactKeys: new Set<string>(),
        totalAmountDue: 0,
      };

    currencySummary.invoiceCount += 1;
    currencySummary.contactKeys.add(contactKey);
    currencySummary.totalAmountDue += amountDue;
    totalsByCurrency.set(currency, currencySummary);

    invoiceCount += 1;

    const updatedDate = toOptionalDate(invoice.updatedDateUTC);
    if (updatedDate && (!sourceUpdatedAt || updatedDate > sourceUpdatedAt)) {
      sourceUpdatedAt = updatedDate;
    }
  }

  const contactPayloads = Array.from(contacts.values())
    .map(
      (contact): OpenInvoicesContactPayload<TInvoice> => ({
        contactId: contact.contactId,
        contactName: contact.contactName,
        contactStatus: contact.contactStatus,
        currency: contact.currency,
        invoiceCount: contact.invoiceCount,
        totalAmountDue: contact.totalAmountDue,
        oldestDueDate: toDateOnlyString(contact.oldestDueDate),
        latestDueDate: toDateOnlyString(contact.latestDueDate),
        invoices: contact.invoices.sort((left, right) =>
          compareOpenInvoicePayloadsByDueDate(left, right)
        ),
      })
    )
    .sort((left, right) => {
      if (right.totalAmountDue !== left.totalAmountDue) {
        return right.totalAmountDue - left.totalAmountDue;
      }

      const nameOrder = compareNullableStrings(left.contactName, right.contactName);
      if (nameOrder !== 0) {
        return nameOrder;
      }

      return compareNullableStrings(left.currency, right.currency);
    });

  const currencyPayloads = Array.from(totalsByCurrency.values())
    .map(
      (currency): OpenInvoicesCurrencyPayload => ({
        currency: currency.currency,
        invoiceCount: currency.invoiceCount,
        contactCount: currency.contactKeys.size,
        totalAmountDue: currency.totalAmountDue,
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
  } as Prisma.InputJsonObject & OpenInvoicesPayload<TInvoice>;

  const snapshotCurrency = deriveSnapshotCurrency(currencyPayloads);

  return {
    snapshotType: input.snapshotType,
    asOfDate: input.asOfDate,
    periodEnd: input.asOfDate,
    rowCount: invoiceCount,
    scope: "organisation",
    currency: snapshotCurrency,
    payload,
    sourceUpdatedAt,
  };
}

// test seam
export function buildFinanceAccountsReceivableInvoicesSnapshot(input: {
  asOfDate: Date;
  invoices: Invoice[];
}): FinanceSyncSnapshotInput {
  return buildFinanceOpenInvoicesSnapshot({
    asOfDate: input.asOfDate,
    invoices: input.invoices,
    invoiceType: "ACCREC",
    snapshotType: FinanceSnapshotType.ACCOUNTS_RECEIVABLE_INVOICES,
    buildInvoicePayload: (
      invoice,
      { amountDue, currency }
    ): FinanceAccountsReceivableInvoicePayload => ({
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
      subTotal: typeof invoice.subTotal === "number" ? invoice.subTotal : null,
      totalTax: typeof invoice.totalTax === "number" ? invoice.totalTax : null,
      total: typeof invoice.total === "number" ? invoice.total : null,
      amountPaid:
        typeof invoice.amountPaid === "number" ? invoice.amountPaid : null,
      amountCredited:
        typeof invoice.amountCredited === "number" ? invoice.amountCredited : null,
      amountDue,
    }),
  });
}

// test seam
export function buildFinanceAccountsPayableInvoicesSnapshot(input: {
  asOfDate: Date;
  invoices: Invoice[];
}): FinanceSyncSnapshotInput {
  return buildFinanceOpenInvoicesSnapshot({
    asOfDate: input.asOfDate,
    invoices: input.invoices,
    invoiceType: "ACCPAY",
    snapshotType: FinanceSnapshotType.ACCOUNTS_PAYABLE_INVOICES,
    buildInvoicePayload: (
      invoice,
      { amountDue, currency }
    ): FinanceAccountsPayableInvoicePayload => ({
      invoiceId: toOptionalText(invoice.invoiceID),
      invoiceNumber: toOptionalText(invoice.invoiceNumber),
      reference: toOptionalText(invoice.reference),
      status: toOptionalText(invoice.status),
      invoiceDate: toOptionalDateOnlyText(invoice.date),
      dueDate: toOptionalDateOnlyText(invoice.dueDate),
      plannedPaymentDate: toOptionalDateOnlyText(invoice.plannedPaymentDate),
      updatedDateUTC: toOptionalDate(invoice.updatedDateUTC)?.toISOString() ?? null,
      currency,
      currencyRate:
        typeof invoice.currencyRate === "number" ? invoice.currencyRate : null,
      subTotal: typeof invoice.subTotal === "number" ? invoice.subTotal : null,
      totalTax: typeof invoice.totalTax === "number" ? invoice.totalTax : null,
      total: typeof invoice.total === "number" ? invoice.total : null,
      amountPaid:
        typeof invoice.amountPaid === "number" ? invoice.amountPaid : null,
      amountCredited:
        typeof invoice.amountCredited === "number" ? invoice.amountCredited : null,
      amountDue,
    }),
  });
}
