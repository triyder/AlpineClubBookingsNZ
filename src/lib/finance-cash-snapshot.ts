import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import { formatCents } from "@/lib/utils";

const FINANCE_TIMEZONE = APP_TIME_ZONE;

/**
 * Parser for stored BANK_BALANCES finance snapshots. The dashboard's
 * "Latest bank balance" KPI reads the most recent snapshot through this;
 * month-granular cash history comes from the monthly fact table instead
 * (see finance-monthly-balance.ts).
 */

export interface FinanceCashSnapshotRecord {
  id: string;
  asOfDate: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  sourceUpdatedAt: Date | null;
  payload: unknown;
}

interface FinanceSnapshotReportCell {
  value: string | null;
}

interface FinanceSnapshotReportRow {
  rowType: string | null;
  title: string | null;
  cells: FinanceSnapshotReportCell[];
  rows: FinanceSnapshotReportRow[];
}

interface FinanceSnapshotReportField {
  fieldId: string | null;
  description: string | null;
  value: string | null;
}

interface FinanceSnapshotReportPayload {
  reportDate: string | null;
  reportTitles: string[];
  fields: FinanceSnapshotReportField[];
  rows: FinanceSnapshotReportRow[];
}

export interface ParsedCashAccount {
  label: string;
  balanceCents: number;
}

export interface ParsedCashSnapshot {
  snapshotId: string;
  snapshotLabel: string;
  sourceWindow: string;
  totalBalanceCents: number;
  totalBalance: string;
  accountCount: number;
  sourceUpdatedAtLabel: string;
  accounts: ParsedCashAccount[];
}

export function parseCashSnapshot(
  snapshot: FinanceCashSnapshotRecord
): ParsedCashSnapshot | null {
  const payload = readReportPayload(snapshot.payload);

  if (!payload) {
    return null;
  }

  const accounts = extractCashAccounts(payload.rows);
  const totalBalanceCents =
    extractCashSummaryCents(payload.rows) ?? sumCashAccounts(accounts);

  if (totalBalanceCents === null) {
    return null;
  }

  return {
    snapshotId: snapshot.id,
    snapshotLabel: formatDisplayDate(snapshot.asOfDate),
    sourceWindow: formatSnapshotWindow(snapshot.periodStart, snapshot.periodEnd),
    totalBalanceCents,
    totalBalance: formatCents(totalBalanceCents),
    accountCount: accounts.length,
    sourceUpdatedAtLabel: snapshot.sourceUpdatedAt
      ? formatDateTime(snapshot.sourceUpdatedAt.toISOString())
      : "Snapshot update time unavailable",
    accounts,
  };
}

function readReportPayload(value: unknown): FinanceSnapshotReportPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    reportDate: readOptionalString(value.reportDate),
    reportTitles: Array.isArray(value.reportTitles)
      ? value.reportTitles
          .map((title) => readOptionalString(title))
          .filter((title): title is string => title !== null)
      : [],
    fields: readReportFields(value.fields),
    rows: readReportRows(value.rows),
  };
}

function readReportFields(value: unknown): FinanceSnapshotReportField[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((field) => {
    if (!isRecord(field)) {
      return [];
    }

    return [
      {
        fieldId: readOptionalString(field.fieldId),
        description: readOptionalString(field.description),
        value: readOptionalString(field.value),
      },
    ];
  });
}

function readReportRows(value: unknown): FinanceSnapshotReportRow[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((row) => {
    if (!isRecord(row)) {
      return [];
    }

    return [
      {
        rowType: readOptionalString(row.rowType),
        title: readOptionalString(row.title),
        cells: readReportCells(row.cells),
        rows: readReportRows(row.rows),
      },
    ];
  });
}

function readReportCells(value: unknown): FinanceSnapshotReportCell[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((cell) => {
    if (!isRecord(cell)) {
      return [];
    }

    return [
      {
        value: readOptionalString(cell.value),
      },
    ];
  });
}

function extractCashAccounts(
  rows: FinanceSnapshotReportRow[]
): ParsedCashAccount[] {
  const balances = new Map<string, number>();

  for (const row of flattenReportRows(rows)) {
    if (row.rowType?.toLowerCase() !== "row") {
      continue;
    }

    const label = readRowLabel(row);
    const balanceCents = readRowAmountCents(row);

    if (!label || balanceCents === null) {
      continue;
    }

    if (label.toLowerCase().includes("total")) {
      continue;
    }

    balances.set(label, (balances.get(label) ?? 0) + balanceCents);
  }

  return Array.from(balances.entries())
    .map(([label, balanceCents]) => ({
      label,
      balanceCents,
    }))
    .sort((left, right) => right.balanceCents - left.balanceCents);
}

function extractCashSummaryCents(rows: FinanceSnapshotReportRow[]) {
  const summaryRows = flattenReportRows(rows).filter(
    (row) => row.rowType?.toLowerCase() === "summaryrow"
  );

  for (const row of summaryRows) {
    const label = readRowLabel(row)?.toLowerCase();
    const amountCents = readRowAmountCents(row);

    if (amountCents !== null && label && label.includes("total")) {
      return amountCents;
    }
  }

  for (const row of summaryRows) {
    const amountCents = readRowAmountCents(row);

    if (amountCents !== null) {
      return amountCents;
    }
  }

  return null;
}

function flattenReportRows(rows: FinanceSnapshotReportRow[]) {
  const flattened: FinanceSnapshotReportRow[] = [];

  for (const row of rows) {
    flattened.push(row, ...flattenReportRows(row.rows));
  }

  return flattened;
}

function sumCashAccounts(accounts: ParsedCashAccount[]) {
  if (accounts.length === 0) {
    return null;
  }

  return accounts.reduce((total, account) => total + account.balanceCents, 0);
}

function readRowLabel(row: FinanceSnapshotReportRow) {
  return (
    row.cells
      .map((cell) => cell.value?.trim())
      .find((value): value is string => Boolean(value)) ?? row.title
  );
}

function readRowAmountCents(row: FinanceSnapshotReportRow) {
  for (const cell of [...row.cells].reverse()) {
    const amountCents = parseFinanceAmountToCents(cell.value);

    if (amountCents !== null) {
      return amountCents;
    }
  }

  return null;
}

function parseFinanceAmountToCents(value: string | null) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const isBracketNegative =
    trimmed.startsWith("(") && trimmed.endsWith(")") && trimmed.length > 2;
  const normalized = (isBracketNegative ? trimmed.slice(1, -1) : trimmed).replace(
    /,/g,
    ""
  );
  const parsed = Number.parseFloat(normalized);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.round((isBracketNegative ? parsed * -1 : parsed) * 100);
}

function formatSnapshotWindow(periodStart: Date | null, periodEnd: Date | null) {
  if (!periodStart && !periodEnd) {
    return "Snapshot period not recorded";
  }

  if (!periodStart) {
    return `Through ${formatDisplayDate(periodEnd!)}`;
  }

  if (!periodEnd) {
    return `From ${formatDisplayDate(periodStart)}`;
  }

  return `${formatDisplayDate(periodStart)} to ${formatDisplayDate(periodEnd)}`;
}

function formatDisplayDate(date: Date) {
  return date.toLocaleDateString(APP_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: FINANCE_TIMEZONE,
  });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(APP_LOCALE, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: FINANCE_TIMEZONE,
  });
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
