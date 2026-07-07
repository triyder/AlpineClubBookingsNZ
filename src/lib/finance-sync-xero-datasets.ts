import {
  FinanceMonthlyStatementKind,
  FinanceSnapshotType,
  Prisma,
} from "@prisma/client";
import type {
  Account,
  Invoice,
  ReportCell,
  ReportFields,
  ReportWithRow,
} from "xero-node";
import { APP_TIME_ZONE } from "@/config/operational";
import { parseDateOnly } from "@/lib/date-only";
import {
  extractMonthlyFactsFromReport,
  type FinanceMonthlyChartContext,
} from "@/lib/finance-monthly-facts";
import { loadFinanceMonthlyChartContext } from "@/lib/finance-monthly-fact-store";
import type {
  FinanceSyncDatasetContext,
  FinanceSyncSnapshotInput,
} from "@/lib/finance-sync-service";
import {
  getXeroErrorHeader,
  getXeroErrorStatusCode,
} from "@/lib/xero-error-shape";
import { callXeroApi } from "@/lib/xero";
import { XERO_REPORT_OAUTH_SCOPES } from "@/lib/xero-config";

export const FINANCE_SYNC_DATA_TIMEZONE = APP_TIME_ZONE;
export const FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY =
  "xero-profit-and-loss-monthly";
export const FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY =
  "xero-balance-sheet";
export const FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY =
  "xero-bank-balances";
export const FINANCE_SYNC_XERO_AGED_RECEIVABLES_DATASET_KEY =
  "xero-aged-receivables";
export const FINANCE_SYNC_XERO_ACCOUNTS_RECEIVABLE_INVOICES_DATASET_KEY =
  "xero-accounts-receivable-invoices";
export const FINANCE_SYNC_XERO_AGED_PAYABLES_DATASET_KEY =
  "xero-aged-payables";
export const FINANCE_SYNC_XERO_ACCOUNTS_PAYABLE_INVOICES_DATASET_KEY =
  "xero-accounts-payable-invoices";
export const FINANCE_SYNC_XERO_CHART_OF_ACCOUNTS_DATASET_KEY =
  "xero-chart-of-accounts";
export const FINANCE_SYNC_XERO_PROFIT_AND_LOSS_BY_MONTH_DATASET_KEY =
  "xero-profit-and-loss-by-month";
export const FINANCE_SYNC_XERO_BALANCE_SHEET_BY_MONTH_DATASET_KEY =
  "xero-balance-sheet-by-month";

/**
 * Prior monthly periods requested alongside the primary month, so one report
 * call yields 12 monthly columns. Xero caps report comparison periods at 11.
 */
export const FINANCE_MONTHLY_FACTS_PRIOR_PERIODS = 11;

const FINANCE_XERO_PAGE_SIZE = 100;
const FINANCE_AGED_INVOICE_STATUSES = [
  "AUTHORISED",
  "SUBMITTED",
] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const XERO_REPORT_SCOPE_BY_OPERATION = {
  getReportProfitAndLoss: XERO_REPORT_OAUTH_SCOPES.profitAndLoss,
  getReportBalanceSheet: XERO_REPORT_OAUTH_SCOPES.balanceSheet,
  getReportBankSummary: XERO_REPORT_OAUTH_SCOPES.bankSummary,
} as const;

type FinanceOpenInvoiceType = "ACCREC" | "ACCPAY";
type FinanceAgedSnapshotType = "AGED_RECEIVABLES" | "AGED_PAYABLES";
type FinanceAgedInvoiceBucketKey =
  | "current"
  | "days1To30"
  | "days31To60"
  | "days61To90"
  | "days91Plus";

interface XeroReportAttributeLike {
  id?: string;
  value?: string;
}

interface XeroReportRowLike {
  rowType?: unknown;
  title?: string;
  cells?: XeroReportCellLike[];
  rows?: XeroReportRowLike[];
}

interface XeroReportCellLike extends ReportCell {
  attributes?: XeroReportAttributeLike[];
}

interface FinanceSnapshotReportCell {
  value: string | null;
  attributes: Array<{
    id: string | null;
    value: string | null;
  }>;
}

interface FinanceSnapshotReportRow {
  rowType: string | null;
  title: string | null;
  cells: FinanceSnapshotReportCell[];
  rows: FinanceSnapshotReportRow[];
}

interface FinanceSnapshotReportPayload {
  reportId: string | null;
  reportName: string | null;
  reportType: string | null;
  reportTitle: string | null;
  reportTitles: string[];
  reportDate: string | null;
  updatedDateUTC: string | null;
  fields: Array<{
    fieldId: string | null;
    description: string | null;
    value: string | null;
  }>;
  rows: FinanceSnapshotReportRow[];
}

interface FinanceAgedInvoiceBucketTotals {
  current: number;
  days1To30: number;
  days31To60: number;
  days61To90: number;
  days91Plus: number;
  overdue: number;
  total: number;
}

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

interface FinanceAccountsReceivableContactPayload {
  contactId: string | null;
  contactName: string | null;
  contactStatus: string | null;
  currency: string;
  invoiceCount: number;
  totalAmountDue: number;
  oldestDueDate: string | null;
  latestDueDate: string | null;
  invoices: FinanceAccountsReceivableInvoicePayload[];
}

interface FinanceAccountsReceivableCurrencyPayload {
  currency: string;
  invoiceCount: number;
  contactCount: number;
  totalAmountDue: number;
}

interface FinanceAccountsReceivableInvoicesPayload {
  asOfDate: string;
  invoiceCount: number;
  contactCount: number;
  currencies: string[];
  totalsByCurrency: FinanceAccountsReceivableCurrencyPayload[];
  contacts: FinanceAccountsReceivableContactPayload[];
}

interface FinanceAccountsReceivableContactAccumulator {
  contactId: string | null;
  contactName: string | null;
  contactStatus: string | null;
  currency: string;
  invoiceCount: number;
  totalAmountDue: number;
  oldestDueDate: Date | null;
  latestDueDate: Date | null;
  invoices: FinanceAccountsReceivableInvoicePayload[];
}

interface FinanceAccountsReceivableCurrencyAccumulator {
  currency: string;
  invoiceCount: number;
  contactKeys: Set<string>;
  totalAmountDue: number;
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

interface FinanceAccountsPayableContactPayload {
  contactId: string | null;
  contactName: string | null;
  contactStatus: string | null;
  currency: string;
  invoiceCount: number;
  totalAmountDue: number;
  oldestDueDate: string | null;
  latestDueDate: string | null;
  invoices: FinanceAccountsPayableInvoicePayload[];
}

interface FinanceAccountsPayableCurrencyPayload {
  currency: string;
  invoiceCount: number;
  contactCount: number;
  totalAmountDue: number;
}

interface FinanceAccountsPayableInvoicesPayload {
  asOfDate: string;
  invoiceCount: number;
  contactCount: number;
  currencies: string[];
  totalsByCurrency: FinanceAccountsPayableCurrencyPayload[];
  contacts: FinanceAccountsPayableContactPayload[];
}

interface FinanceAccountsPayableContactAccumulator {
  contactId: string | null;
  contactName: string | null;
  contactStatus: string | null;
  currency: string;
  invoiceCount: number;
  totalAmountDue: number;
  oldestDueDate: Date | null;
  latestDueDate: Date | null;
  invoices: FinanceAccountsPayableInvoicePayload[];
}

interface FinanceAccountsPayableCurrencyAccumulator {
  currency: string;
  invoiceCount: number;
  contactKeys: Set<string>;
  totalAmountDue: number;
}

const financeOpenInvoiceListCache = new WeakMap<
  FinanceSyncDatasetContext,
  Map<string, Promise<Invoice[]>>
>();

function getDateOnlyStringForTimeZone(
  date: Date,
  timeZone = FINANCE_SYNC_DATA_TIMEZONE
): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to derive finance date for timezone ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}

function parseRequiredDateOnly(value: string, fieldName: string): Date {
  const parsed = parseDateOnly(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be a valid date-only string`);
  }

  return parsed;
}

function parseOptionalDateOnly(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = parseDateOnly(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getFinanceReportWindow(startedAt: Date) {
  const asOfDateString = getDateOnlyStringForTimeZone(startedAt);
  const periodStartString = `${asOfDateString.slice(0, 7)}-01`;

  return {
    asOfDate: parseRequiredDateOnly(asOfDateString, "asOfDate"),
    asOfDateString,
    periodStart: parseRequiredDateOnly(periodStartString, "periodStart"),
    periodStartString,
  };
}

/** Month key ("YYYY-MM") for a timestamp, in the finance data timezone. */
export function getFinanceMonthKeyForDate(date: Date): string {
  return getDateOnlyStringForTimeZone(date).slice(0, 7);
}

function monthStartString(monthKey: string): string {
  return `${monthKey}-01`;
}

function monthEndString(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return `${monthKey}-${String(lastDay).padStart(2, "0")}`;
}

function toOptionalDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toDateOnlyString(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function toOptionalText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const text = String(value).trim();
  return text ? text : null;
}

function toOptionalDateOnlyText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : toDateOnlyString(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  return toOptionalText(value);
}

function getFinanceXeroScopeErrorMessage(
  error: unknown,
  operation: string
): string | null {
  if (getXeroErrorStatusCode(error) !== 401) {
    return null;
  }

  const wwwAuthenticate = getXeroErrorHeader(error, "www-authenticate")?.toLowerCase();
  if (!wwwAuthenticate?.includes("insufficient_scope")) {
    return null;
  }

  const requiredScope =
    XERO_REPORT_SCOPE_BY_OPERATION[
      operation as keyof typeof XERO_REPORT_SCOPE_BY_OPERATION
    ] ?? null;

  return requiredScope
    ? `Xero is missing a required OAuth scope for ${operation}. Add ${requiredScope} to the Xero app and reconnect Xero from the admin panel.`
    : `Xero is missing a required OAuth scope for ${operation}. Update the Xero app scopes and reconnect Xero from the admin panel.`;
}

function normalizeFinanceXeroError(error: unknown, operation: string): unknown {
  const scopeErrorMessage = getFinanceXeroScopeErrorMessage(error, operation);
  if (!scopeErrorMessage) {
    return error;
  }

  return new Error(scopeErrorMessage);
}

/**
 * Wrap a finance report Xero call so a 401 insufficient_scope failure is
 * rethrown with an actionable "reconnect Xero" message. Usage metering and
 * rate-limit handling are already done by the inner callXeroApi against the
 * operational connection.
 */
async function withFinanceReportScopeError<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw normalizeFinanceXeroError(error, operation);
  }
}

function mapReportField(field: ReportFields) {
  return {
    fieldId: field.fieldID ?? null,
    description: field.description ?? null,
    value: field.value ?? null,
  };
}

function mapReportCell(cell: XeroReportCellLike): FinanceSnapshotReportCell {
  return {
    value: cell.value ?? null,
    attributes: (cell.attributes ?? []).map((attribute) => ({
      id: attribute.id ?? null,
      value: attribute.value ?? null,
    })),
  };
}

function mapReportRows(rows: readonly XeroReportRowLike[]): FinanceSnapshotReportRow[] {
  return rows.map((row) => ({
    rowType: row.rowType ? String(row.rowType) : null,
    title: row.title ?? null,
    cells: (row.cells ?? []).map((cell) => mapReportCell(cell)),
    rows: mapReportRows(row.rows ?? []),
  }));
}

function countReportRows(rows: readonly FinanceSnapshotReportRow[]): number {
  return rows.reduce((count, row) => {
    const rowCount =
      row.rowType === "Row" || row.rowType === "SummaryRow" ? 1 : 0;

    return count + rowCount + countReportRows(row.rows);
  }, 0);
}

function getRequiredReport(
  reportResponse: { reports?: ReportWithRow[] },
  operation: string
): ReportWithRow {
  const report = reportResponse.reports?.[0];

  if (!report) {
    throw new Error(`${operation} did not return a report`);
  }

  return report;
}

function createEmptyAgedInvoiceTotals(): FinanceAgedInvoiceBucketTotals {
  return {
    current: 0,
    days1To30: 0,
    days31To60: 0,
    days61To90: 0,
    days91Plus: 0,
    overdue: 0,
    total: 0,
  };
}

function addToAgedInvoiceTotals(
  totals: FinanceAgedInvoiceBucketTotals,
  bucket: FinanceAgedInvoiceBucketKey,
  amountDue: number
): void {
  totals[bucket] += amountDue;
  totals.total += amountDue;

  if (bucket !== "current") {
    totals.overdue += amountDue;
  }
}

function getInvoiceContactName(invoice: Invoice): string | null {
  const name = toOptionalText(invoice.contact?.name);
  if (name) {
    return name;
  }

  const fallback = [invoice.contact?.firstName, invoice.contact?.lastName]
    .map((value) => toOptionalText(value))
    .filter((value): value is string => value !== null)
    .join(" ")
    .trim();

  return fallback || null;
}

function getInvoiceCurrency(invoice: Invoice): string {
  return toOptionalText(invoice.currencyCode) ?? "UNKNOWN";
}

function getInvoiceAmountDue(invoice: Invoice): number {
  if (typeof invoice.amountDue === "number" && Number.isFinite(invoice.amountDue)) {
    return Math.max(invoice.amountDue, 0);
  }

  const total = typeof invoice.total === "number" ? invoice.total : 0;
  const amountPaid =
    typeof invoice.amountPaid === "number" ? invoice.amountPaid : 0;
  const amountCredited =
    typeof invoice.amountCredited === "number" ? invoice.amountCredited : 0;

  return Math.max(total - amountPaid - amountCredited, 0);
}

function getDaysOverdue(asOfDate: Date, dueDate: Date | null): number | null {
  if (!dueDate) {
    return null;
  }

  return Math.floor((asOfDate.getTime() - dueDate.getTime()) / MS_PER_DAY);
}

function getAgedInvoiceBucket(
  asOfDate: Date,
  dueDate: Date | null
): {
  bucket: FinanceAgedInvoiceBucketKey;
  daysOverdue: number | null;
} {
  const daysOverdue = getDaysOverdue(asOfDate, dueDate);

  if (daysOverdue === null || daysOverdue <= 0) {
    return { bucket: "current", daysOverdue };
  }

  if (daysOverdue <= 30) {
    return { bucket: "days1To30", daysOverdue };
  }

  if (daysOverdue <= 60) {
    return { bucket: "days31To60", daysOverdue };
  }

  if (daysOverdue <= 90) {
    return { bucket: "days61To90", daysOverdue };
  }

  return { bucket: "days91Plus", daysOverdue };
}

function buildOpenInvoiceWhereClause(
  invoiceType: FinanceOpenInvoiceType,
  asOfDateString: string
): string {
  const [year, month, day] = asOfDateString.split("-").map((value) => Number(value));

  return [`Type=="${invoiceType}"`, `Date <= DateTime(${year},${month},${day})`].join(
    " AND "
  );
}

function compareNullableStrings(a: unknown, b: unknown): number {
  const left = toOptionalText(a);
  const right = toOptionalText(b);

  if (left === right) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left.localeCompare(right);
}

function getContactAccumulatorKey(invoice: Invoice): string {
  const contactId = toOptionalText(invoice.contact?.contactID) ?? "";
  const contactName = getInvoiceContactName(invoice) ?? "";
  const invoiceId = toOptionalText(invoice.invoiceID) ?? "";
  const invoiceNumber = toOptionalText(invoice.invoiceNumber) ?? "";

  return [
    contactId || contactName || invoiceId || invoiceNumber || "unknown",
    getInvoiceCurrency(invoice),
  ].join("::");
}

function isEligibleOpenInvoice(
  invoice: Invoice,
  asOfDate: Date,
  invoiceType: FinanceOpenInvoiceType
): boolean {
  if (!invoice.type || String(invoice.type) !== invoiceType) {
    return false;
  }

  if (getInvoiceAmountDue(invoice) <= 0) {
    return false;
  }

  const invoiceDate = parseOptionalDateOnly(invoice.date);
  if (invoiceDate && invoiceDate.getTime() > asOfDate.getTime()) {
    return false;
  }

  return true;
}

function getFinanceOpenInvoiceCache(
  context: FinanceSyncDatasetContext
): Map<string, Promise<Invoice[]>> {
  const existingCache = financeOpenInvoiceListCache.get(context);
  if (existingCache) {
    return existingCache;
  }

  const nextCache = new Map<string, Promise<Invoice[]>>();
  financeOpenInvoiceListCache.set(context, nextCache);
  return nextCache;
}

async function listFinanceOpenInvoices(
  context: FinanceSyncDatasetContext,
  asOfDateString: string,
  options: {
    invoiceType: FinanceOpenInvoiceType;
    contextLabel: string;
  }
): Promise<Invoice[]> {
  const cacheKey = `${options.invoiceType}:${asOfDateString}`;
  const cache = getFinanceOpenInvoiceCache(context);
  const cachedPromise = cache.get(cacheKey);
  if (cachedPromise) {
    return cachedPromise;
  }

  const invoicePromise = (async () => {
    const invoices: Invoice[] = [];
    let page = 1;

    while (true) {
      const response = await withFinanceReportScopeError(
        "getInvoices",
        () =>
          callXeroApi(
            () =>
              context.xero.accountingApi.getInvoices(
                context.xeroTenantId,
                undefined,
                buildOpenInvoiceWhereClause(options.invoiceType, asOfDateString),
                "DueDate ASC",
                undefined,
                undefined,
                undefined,
                [...FINANCE_AGED_INVOICE_STATUSES],
                page,
                false,
                false,
                undefined,
                false,
                FINANCE_XERO_PAGE_SIZE
              ),
            {
              operation: "getInvoices",
              resourceType: "INVOICE",
              workflow: context.workflow,
              context: `financeSyncDatasets ${options.contextLabel} page ${page}`,
            }
          )
      );

      const pageInvoices = response.body.invoices ?? [];
      invoices.push(...pageInvoices);

      if (pageInvoices.length < FINANCE_XERO_PAGE_SIZE) {
        break;
      }

      page += 1;
    }

    return invoices;
  })();

  cache.set(cacheKey, invoicePromise);

  try {
    return await invoicePromise;
  } catch (error) {
    cache.delete(cacheKey);
    throw error;
  }
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
    contactSummary.oldestDueDate =
      !contactSummary.oldestDueDate ||
      (dueDate && dueDate.getTime() < contactSummary.oldestDueDate.getTime())
        ? dueDate ?? contactSummary.oldestDueDate
        : contactSummary.oldestDueDate;
    contactSummary.latestDueDate =
      !contactSummary.latestDueDate ||
      (dueDate && dueDate.getTime() > contactSummary.latestDueDate.getTime())
        ? dueDate ?? contactSummary.latestDueDate
        : contactSummary.latestDueDate;
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
        invoices: contact.invoices.sort((left, right) => {
          const dueDateOrder = compareNullableStrings(left.dueDate, right.dueDate);
          if (dueDateOrder !== 0) {
            return dueDateOrder;
          }

          const invoiceNumberOrder = compareNullableStrings(
            left.invoiceNumber,
            right.invoiceNumber
          );
          if (invoiceNumberOrder !== 0) {
            return invoiceNumberOrder;
          }

          return compareNullableStrings(left.invoiceId, right.invoiceId);
        }),
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

  const currencies = currencyPayloads.map((currency) => currency.currency);
  const snapshotCurrency =
    currencies.length === 1 && currencies[0] !== "UNKNOWN" ? currencies[0] : null;

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
export function buildFinanceReportSnapshot(input: {
  snapshotType: FinanceSnapshotType;
  asOfDate: Date;
  report: ReportWithRow;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}): FinanceSyncSnapshotInput {
  const rows = mapReportRows(input.report.rows ?? []);
  const payload = {
    reportId: input.report.reportID ?? null,
    reportName: input.report.reportName ?? null,
    reportType: input.report.reportType ?? null,
    reportTitle: input.report.reportTitle ?? null,
    reportTitles: input.report.reportTitles ?? [],
    reportDate: input.report.reportDate ?? null,
    updatedDateUTC: toOptionalDate(input.report.updatedDateUTC)?.toISOString() ?? null,
    fields: (input.report.fields ?? []).map((field) => mapReportField(field)),
    rows,
  } as Prisma.InputJsonObject & FinanceSnapshotReportPayload;

  return {
    snapshotType: input.snapshotType,
    asOfDate: input.asOfDate,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    rowCount: countReportRows(rows),
    payload,
    sourceUpdatedAt: toOptionalDate(input.report.updatedDateUTC),
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
export function buildFinanceAccountsReceivableInvoicesSnapshot(input: {
  asOfDate: Date;
  invoices: Invoice[];
}): FinanceSyncSnapshotInput {
  const contacts = new Map<string, FinanceAccountsReceivableContactAccumulator>();
  const totalsByCurrency = new Map<
    string,
    FinanceAccountsReceivableCurrencyAccumulator
  >();
  let sourceUpdatedAt: Date | null = null;
  let invoiceCount = 0;

  for (const invoice of input.invoices) {
    if (!isEligibleOpenInvoice(invoice, input.asOfDate, "ACCREC")) {
      continue;
    }

    const amountDue = getInvoiceAmountDue(invoice);
    const currency = getInvoiceCurrency(invoice);
    const dueDate = parseOptionalDateOnly(invoice.dueDate);
    const contactKey = getContactAccumulatorKey(invoice);
    const invoicePayload: FinanceAccountsReceivableInvoicePayload = {
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
    };

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
    contactSummary.oldestDueDate =
      !contactSummary.oldestDueDate ||
      (dueDate && dueDate.getTime() < contactSummary.oldestDueDate.getTime())
        ? dueDate ?? contactSummary.oldestDueDate
        : contactSummary.oldestDueDate;
    contactSummary.latestDueDate =
      !contactSummary.latestDueDate ||
      (dueDate && dueDate.getTime() > contactSummary.latestDueDate.getTime())
        ? dueDate ?? contactSummary.latestDueDate
        : contactSummary.latestDueDate;
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
      (contact): FinanceAccountsReceivableContactPayload => ({
        contactId: contact.contactId,
        contactName: contact.contactName,
        contactStatus: contact.contactStatus,
        currency: contact.currency,
        invoiceCount: contact.invoiceCount,
        totalAmountDue: contact.totalAmountDue,
        oldestDueDate: toDateOnlyString(contact.oldestDueDate),
        latestDueDate: toDateOnlyString(contact.latestDueDate),
        invoices: contact.invoices.sort((left, right) => {
          const dueDateOrder = compareNullableStrings(left.dueDate, right.dueDate);
          if (dueDateOrder !== 0) {
            return dueDateOrder;
          }

          const invoiceNumberOrder = compareNullableStrings(
            left.invoiceNumber,
            right.invoiceNumber
          );
          if (invoiceNumberOrder !== 0) {
            return invoiceNumberOrder;
          }

          return compareNullableStrings(left.invoiceId, right.invoiceId);
        }),
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
      (currency): FinanceAccountsReceivableCurrencyPayload => ({
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
  } as Prisma.InputJsonObject & FinanceAccountsReceivableInvoicesPayload;

  const currencies = currencyPayloads.map((currency) => currency.currency);
  const snapshotCurrency =
    currencies.length === 1 && currencies[0] !== "UNKNOWN" ? currencies[0] : null;

  return {
    snapshotType: FinanceSnapshotType.ACCOUNTS_RECEIVABLE_INVOICES,
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

// test seam
export function buildFinanceAccountsPayableInvoicesSnapshot(input: {
  asOfDate: Date;
  invoices: Invoice[];
}): FinanceSyncSnapshotInput {
  const contacts = new Map<string, FinanceAccountsPayableContactAccumulator>();
  const totalsByCurrency = new Map<
    string,
    FinanceAccountsPayableCurrencyAccumulator
  >();
  let sourceUpdatedAt: Date | null = null;
  let invoiceCount = 0;

  for (const invoice of input.invoices) {
    if (!isEligibleOpenInvoice(invoice, input.asOfDate, "ACCPAY")) {
      continue;
    }

    const amountDue = getInvoiceAmountDue(invoice);
    const currency = getInvoiceCurrency(invoice);
    const dueDate = parseOptionalDateOnly(invoice.dueDate);
    const contactKey = getContactAccumulatorKey(invoice);
    const invoicePayload: FinanceAccountsPayableInvoicePayload = {
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
    };

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
    contactSummary.oldestDueDate =
      !contactSummary.oldestDueDate ||
      (dueDate && dueDate.getTime() < contactSummary.oldestDueDate.getTime())
        ? dueDate ?? contactSummary.oldestDueDate
        : contactSummary.oldestDueDate;
    contactSummary.latestDueDate =
      !contactSummary.latestDueDate ||
      (dueDate && dueDate.getTime() > contactSummary.latestDueDate.getTime())
        ? dueDate ?? contactSummary.latestDueDate
        : contactSummary.latestDueDate;
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
      (contact): FinanceAccountsPayableContactPayload => ({
        contactId: contact.contactId,
        contactName: contact.contactName,
        contactStatus: contact.contactStatus,
        currency: contact.currency,
        invoiceCount: contact.invoiceCount,
        totalAmountDue: contact.totalAmountDue,
        oldestDueDate: toDateOnlyString(contact.oldestDueDate),
        latestDueDate: toDateOnlyString(contact.latestDueDate),
        invoices: contact.invoices.sort((left, right) => {
          const dueDateOrder = compareNullableStrings(left.dueDate, right.dueDate);
          if (dueDateOrder !== 0) {
            return dueDateOrder;
          }

          const invoiceNumberOrder = compareNullableStrings(
            left.invoiceNumber,
            right.invoiceNumber
          );
          if (invoiceNumberOrder !== 0) {
            return invoiceNumberOrder;
          }

          return compareNullableStrings(left.invoiceId, right.invoiceId);
        }),
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
      (currency): FinanceAccountsPayableCurrencyPayload => ({
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
  } as Prisma.InputJsonObject & FinanceAccountsPayableInvoicesPayload;

  const currencies = currencyPayloads.map((currency) => currency.currency);
  const snapshotCurrency =
    currencies.length === 1 && currencies[0] !== "UNKNOWN" ? currencies[0] : null;

  return {
    snapshotType: FinanceSnapshotType.ACCOUNTS_PAYABLE_INVOICES,
    asOfDate: input.asOfDate,
    periodEnd: input.asOfDate,
    rowCount: invoiceCount,
    scope: "organisation",
    currency: snapshotCurrency,
    payload,
    sourceUpdatedAt,
  };
}

export async function syncFinanceProfitAndLossMonthlySnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  const response = await withFinanceReportScopeError(
    "getReportProfitAndLoss",
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportProfitAndLoss(
            context.xeroTenantId,
            window.periodStartString,
            window.asOfDateString,
            1,
            "MONTH",
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            false
          ),
        {
          operation: "getReportProfitAndLoss",
          resourceType: "REPORT",
          workflow: context.workflow,
          context: "financeSyncDatasets profitAndLossMonthly",
        }
      )
  );

  return buildFinanceReportSnapshot({
    snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
    asOfDate: window.asOfDate,
    periodStart: window.periodStart,
    periodEnd: window.asOfDate,
    report: getRequiredReport(response.body, "getReportProfitAndLoss"),
  });
}

export async function syncFinanceBalanceSheetSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  const response = await withFinanceReportScopeError(
    "getReportBalanceSheet",
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportBalanceSheet(
            context.xeroTenantId,
            window.asOfDateString,
            1,
            "MONTH",
            undefined,
            undefined,
            true,
            false
          ),
        {
          operation: "getReportBalanceSheet",
          resourceType: "REPORT",
          workflow: context.workflow,
          context: "financeSyncDatasets balanceSheet",
        }
      )
  );

  return buildFinanceReportSnapshot({
    snapshotType: FinanceSnapshotType.BALANCE_SHEET,
    asOfDate: window.asOfDate,
    periodEnd: window.asOfDate,
    report: getRequiredReport(response.body, "getReportBalanceSheet"),
  });
}

export interface FinanceMonthlyFactsWindowInput {
  /** Window end month key ("YYYY-MM", inclusive); covers this + 11 prior. */
  endMonth: string;
  /** Month key of the sync date in NZ time; months >= it flag provisional. */
  currentMonth: string;
  /** Injectable chart context so backfill chunks avoid reloading it. */
  chart?: FinanceMonthlyChartContext;
}

function requireMonthlyFactChartContext(
  chart: FinanceMonthlyChartContext
): FinanceMonthlyChartContext {
  if (chart.accountsById.size === 0) {
    throw new Error(
      "No chart-of-accounts snapshot is stored yet, so monthly account facts cannot be derived. The xero-chart-of-accounts dataset must succeed first."
    );
  }

  return chart;
}

/**
 * Derive fact rows from a freshly pulled multi-period report and attach them
 * to the snapshot for runFinanceSync to persist. Throws instead of returning
 * partial facts when the report cannot be fully read — an unparseable period
 * header, a header whose date cells only partially parse, or any leaf row that
 * carries an amount but does not resolve to a GL code — so a bad pull fails the
 * dataset loudly rather than silently replacing stored months with an
 * incomplete set (the throw runs before persistence, so the stored months are
 * left untouched and only this dataset is marked failed).
 */
function attachMonthlyFacts(input: {
  snapshot: FinanceSyncSnapshotInput;
  chart: FinanceMonthlyChartContext;
  statementKind: FinanceMonthlyStatementKind;
  sourceReport: string;
  currentMonth: string;
  operation: string;
}): FinanceSyncSnapshotInput {
  const extraction = extractMonthlyFactsFromReport({
    payload: input.snapshot.payload,
    chart: input.chart,
    provisionalFromMonth: input.currentMonth,
  });

  if (extraction.months.length === 0) {
    throw new Error(
      `${input.operation} returned a report without parseable monthly period columns`
    );
  }

  if (extraction.months.length < extraction.periodColumnCount) {
    throw new Error(
      `${input.operation} returned a report whose period header only partially parsed (${extraction.months.length} of ${extraction.periodColumnCount} monthly columns). Refusing to replace stored monthly facts because the unparsed months would linger stale; report an unrecognised Xero date format.`
    );
  }

  if (extraction.unresolvedRowLabels.length > 0) {
    throw new Error(
      `${input.operation} report rows could not be matched to GL codes (${extraction.unresolvedRowLabels.length} unresolved). Refusing to replace stored monthly facts because the unresolved amounts would be dropped; run the chart-of-accounts sync and retry.`
    );
  }

  return {
    ...input.snapshot,
    periodStart: parseRequiredDateOnly(
      monthStartString(extraction.months[0]),
      "periodStart"
    ),
    monthlyFacts: {
      statementKind: input.statementKind,
      months: extraction.months,
      rows: extraction.rows,
      sourceReport: input.sourceReport,
      unresolvedRowLabels: extraction.unresolvedRowLabels,
    },
  };
}

/**
 * Pull a 12-month profit-and-loss report (endMonth + 11 prior monthly
 * columns) and derive PROFIT_AND_LOSS fact rows. The raw report is stored as
 * a PROFIT_AND_LOSS_BY_MONTH snapshot keyed on the window end month, so daily
 * re-pulls overwrite one row per month instead of accumulating.
 */
export async function fetchFinanceProfitAndLossByMonthSnapshot(
  context: FinanceSyncDatasetContext,
  window: FinanceMonthlyFactsWindowInput
): Promise<FinanceSyncSnapshotInput> {
  const chart = requireMonthlyFactChartContext(
    window.chart ?? (await loadFinanceMonthlyChartContext())
  );
  const fromDateString = monthStartString(window.endMonth);
  const toDateString = monthEndString(window.endMonth);
  const response = await withFinanceReportScopeError(
    "getReportProfitAndLoss",
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportProfitAndLoss(
            context.xeroTenantId,
            fromDateString,
            toDateString,
            FINANCE_MONTHLY_FACTS_PRIOR_PERIODS,
            "MONTH",
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            false
          ),
        {
          operation: "getReportProfitAndLoss",
          resourceType: "REPORT",
          workflow: context.workflow,
          context: "financeSyncDatasets profitAndLossByMonth",
        }
      )
  );

  return attachMonthlyFacts({
    snapshot: buildFinanceReportSnapshot({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_BY_MONTH,
      asOfDate: parseRequiredDateOnly(fromDateString, "asOfDate"),
      periodEnd: parseRequiredDateOnly(toDateString, "periodEnd"),
      report: getRequiredReport(response.body, "getReportProfitAndLoss"),
    }),
    chart,
    statementKind: FinanceMonthlyStatementKind.PROFIT_AND_LOSS,
    sourceReport: "getReportProfitAndLoss",
    currentMonth: window.currentMonth,
    operation: "getReportProfitAndLoss",
  });
}

/**
 * Pull a 12-month balance-sheet report (month-end positions for endMonth +
 * 11 prior) and derive BALANCE_SHEET fact rows, stored the same way as the
 * profit-and-loss window above.
 */
export async function fetchFinanceBalanceSheetByMonthSnapshot(
  context: FinanceSyncDatasetContext,
  window: FinanceMonthlyFactsWindowInput
): Promise<FinanceSyncSnapshotInput> {
  const chart = requireMonthlyFactChartContext(
    window.chart ?? (await loadFinanceMonthlyChartContext())
  );
  const toDateString = monthEndString(window.endMonth);
  const response = await withFinanceReportScopeError(
    "getReportBalanceSheet",
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportBalanceSheet(
            context.xeroTenantId,
            toDateString,
            FINANCE_MONTHLY_FACTS_PRIOR_PERIODS,
            "MONTH",
            undefined,
            undefined,
            true,
            false
          ),
        {
          operation: "getReportBalanceSheet",
          resourceType: "REPORT",
          workflow: context.workflow,
          context: "financeSyncDatasets balanceSheetByMonth",
        }
      )
  );

  return attachMonthlyFacts({
    snapshot: buildFinanceReportSnapshot({
      snapshotType: FinanceSnapshotType.BALANCE_SHEET_BY_MONTH,
      asOfDate: parseRequiredDateOnly(monthStartString(window.endMonth), "asOfDate"),
      periodEnd: parseRequiredDateOnly(toDateString, "periodEnd"),
      report: getRequiredReport(response.body, "getReportBalanceSheet"),
    }),
    chart,
    statementKind: FinanceMonthlyStatementKind.BALANCE_SHEET,
    sourceReport: "getReportBalanceSheet",
    currentMonth: window.currentMonth,
    operation: "getReportBalanceSheet",
  });
}

export async function syncFinanceProfitAndLossByMonthFacts(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const currentMonth = getFinanceMonthKeyForDate(context.startedAt);

  return fetchFinanceProfitAndLossByMonthSnapshot(context, {
    endMonth: currentMonth,
    currentMonth,
  });
}

export async function syncFinanceBalanceSheetByMonthFacts(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const currentMonth = getFinanceMonthKeyForDate(context.startedAt);

  return fetchFinanceBalanceSheetByMonthSnapshot(context, {
    endMonth: currentMonth,
    currentMonth,
  });
}

export async function syncFinanceBankBalancesSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  const response = await withFinanceReportScopeError(
    "getReportBankSummary",
    () =>
      callXeroApi(
        () =>
          context.xero.accountingApi.getReportBankSummary(
            context.xeroTenantId,
            window.periodStartString,
            window.asOfDateString
          ),
        {
          operation: "getReportBankSummary",
          resourceType: "REPORT",
          workflow: context.workflow,
          context: "financeSyncDatasets bankBalances",
        }
      )
  );

  return buildFinanceReportSnapshot({
    snapshotType: FinanceSnapshotType.BANK_BALANCES,
    asOfDate: window.asOfDate,
    periodStart: window.periodStart,
    periodEnd: window.asOfDate,
    report: getRequiredReport(response.body, "getReportBankSummary"),
  });
}

interface FinanceChartOfAccountsEntryPayload {
  accountId: string;
  code: string | null;
  name: string | null;
  type: string | null;
  class: string | null;
  status: string | null;
}

interface FinanceChartOfAccountsPayload {
  accountCount: number;
  accounts: FinanceChartOfAccountsEntryPayload[];
}

// test seam
/**
 * Map the operational chart of accounts into a JSON-safe snapshot. The stored
 * AccountID-to-GL-code entries let revenue reconciliation match profit-and-loss
 * rows (which carry an "account" cell attribute holding the AccountID) to their
 * GL codes without a live Xero call. Mirrors the active-account selection used by
 * the admin chart-of-accounts route, but keeps every account that has an
 * AccountID (including archived ones) so historical reports still resolve.
 */
export function buildFinanceChartOfAccountsSnapshot(input: {
  asOfDate: Date;
  accounts: readonly Account[];
}): FinanceSyncSnapshotInput {
  const entries: FinanceChartOfAccountsEntryPayload[] = input.accounts
    .map((account) => {
      const accountId = toOptionalText(account.accountID);
      if (!accountId) {
        return null;
      }

      return {
        accountId,
        code: toOptionalText(account.code),
        name: toOptionalText(account.name),
        type: account.type != null ? String(account.type) : null,
        class: account._class != null ? String(account._class) : null,
        status: account.status != null ? String(account.status) : null,
      } satisfies FinanceChartOfAccountsEntryPayload;
    })
    .filter((entry): entry is FinanceChartOfAccountsEntryPayload => entry !== null)
    .sort(
      (left, right) =>
        compareNullableStrings(left.code, right.code) ||
        compareNullableStrings(left.name, right.name)
    );

  const payload = {
    accountCount: entries.length,
    accounts: entries,
  } as Prisma.InputJsonObject & FinanceChartOfAccountsPayload;

  return {
    snapshotType: FinanceSnapshotType.CHART_OF_ACCOUNTS,
    asOfDate: input.asOfDate,
    periodEnd: input.asOfDate,
    rowCount: entries.length,
    payload,
  };
}

export async function syncFinanceChartOfAccountsSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  // getAccounts only needs accounting.settings.read, which the operational Xero
  // connection already holds, so this dataset works even before the one-time
  // granular report-scope re-consent that the report datasets require.
  const response = await callXeroApi(
    () => context.xero.accountingApi.getAccounts(context.xeroTenantId),
    {
      operation: "getAccounts",
      resourceType: "ACCOUNT",
      workflow: context.workflow,
      context: "financeSyncDatasets chartOfAccounts",
    }
  );

  return buildFinanceChartOfAccountsSnapshot({
    asOfDate: window.asOfDate,
    accounts: response.body.accounts ?? [],
  });
}

export async function syncFinanceAgedReceivablesSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  const invoices = await listFinanceOpenInvoices(context, window.asOfDateString, {
    invoiceType: "ACCREC",
    contextLabel: "agedReceivables",
  });

  return buildFinanceAgedReceivablesSnapshot({
    asOfDate: window.asOfDate,
    invoices,
  });
}

export async function syncFinanceAccountsReceivableInvoicesSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  const invoices = await listFinanceOpenInvoices(context, window.asOfDateString, {
    invoiceType: "ACCREC",
    contextLabel: "accountsReceivableInvoices",
  });

  return buildFinanceAccountsReceivableInvoicesSnapshot({
    asOfDate: window.asOfDate,
    invoices,
  });
}

export async function syncFinanceAgedPayablesSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  const invoices = await listFinanceOpenInvoices(context, window.asOfDateString, {
    invoiceType: "ACCPAY",
    contextLabel: "agedPayables",
  });

  return buildFinanceAgedPayablesSnapshot({
    asOfDate: window.asOfDate,
    invoices,
  });
}

export async function syncFinanceAccountsPayableInvoicesSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt);
  const invoices = await listFinanceOpenInvoices(context, window.asOfDateString, {
    invoiceType: "ACCPAY",
    contextLabel: "accountsPayableInvoices",
  });

  return buildFinanceAccountsPayableInvoicesSnapshot({
    asOfDate: window.asOfDate,
    invoices,
  });
}
