/**
 * Shared parser for Xero profit-and-loss snapshot payloads.
 *
 * The finance sync stores each Xero report as a normalised JSON payload of
 * rows/cells (see finance-sync-xero-datasets.ts). Several finance features need
 * to walk that structure: the revenue and costs report pages, and the revenue
 * reconciliation. This module centralises the row-walking and amount-parsing so
 * those callers agree on how a P&L is read.
 */

interface PnlReportAttribute {
  id: string | null;
  value: string | null;
}

interface PnlReportCell {
  value: string | null;
  /**
   * Xero attaches structured attributes to report cells. The account-name cell
   * of a leaf row carries an attribute with id "account" whose value is the
   * account's Xero AccountID (a GUID). Revenue reconciliation uses this to match
   * rows to GL codes via the chart-of-accounts snapshot.
   */
  attributes: PnlReportAttribute[];
}

export interface PnlReportRow {
  rowType: string | null;
  title: string | null;
  cells: PnlReportCell[];
  rows: PnlReportRow[];
}

interface PnlReportField {
  fieldId: string | null;
  description: string | null;
  value: string | null;
}

export interface PnlReportPayload {
  reportDate: string | null;
  reportTitles: string[];
  fields: PnlReportField[];
  rows: PnlReportRow[];
}

export interface PnlLineItem {
  label: string;
  amountCents: number;
  /** Xero AccountID for the row, when present; used for GL-code matching. */
  accountId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readReportAttributes(value: unknown): PnlReportAttribute[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((attribute) => {
    if (!isRecord(attribute)) {
      return [];
    }

    return [
      {
        id: readOptionalString(attribute.id),
        value: readOptionalString(attribute.value),
      },
    ];
  });
}

function readReportCells(value: unknown): PnlReportCell[] {
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
        attributes: readReportAttributes(cell.attributes),
      },
    ];
  });
}

function readReportRows(value: unknown): PnlReportRow[] {
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

function readReportFields(value: unknown): PnlReportField[] {
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

/** Parse a stored snapshot payload into a typed P&L structure, or null. */
export function readPnlReportPayload(value: unknown): PnlReportPayload | null {
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

/**
 * Parse a Xero report cell amount into integer cents. Handles thousands
 * separators and bracketed negatives, e.g. "(1,234.50)" -> -123450.
 */
export function parsePnlAmountToCents(value: string | null): number | null {
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

/** The right-most cell that parses as an amount is the period figure. */
export function readRowAmountCents(row: PnlReportRow): number | null {
  for (const cell of [...row.cells].reverse()) {
    const amountCents = parsePnlAmountToCents(cell.value);
    if (amountCents !== null) {
      return amountCents;
    }
  }

  return null;
}

/** The first non-empty cell (or the row title) is the row label. */
export function readRowLabel(row: PnlReportRow): string | null {
  return (
    row.cells
      .map((cell) => cell.value?.trim())
      .find((value): value is string => Boolean(value)) ?? row.title
  );
}

/**
 * The Xero AccountID for a leaf row, read from the cell attribute with id
 * "account". Returns null for header/summary rows or older snapshots stored
 * before cell attributes were captured.
 */
export function readRowAccountId(row: PnlReportRow): string | null {
  for (const cell of row.cells) {
    for (const attribute of cell.attributes) {
      if (attribute.id?.toLowerCase() === "account" && attribute.value) {
        return attribute.value;
      }
    }
  }

  return null;
}

/** First section whose title contains any of the keywords (case-insensitive). */
export function findPnlSection(
  rows: PnlReportRow[],
  keywords: string[]
): PnlReportRow | null {
  for (const row of rows) {
    const title = row.title?.toLowerCase();
    if (
      row.rowType?.toLowerCase() === "section" &&
      title &&
      keywords.some((keyword) => title.includes(keyword))
    ) {
      return row;
    }

    const nested = findPnlSection(row.rows, keywords);
    if (nested) {
      return nested;
    }
  }

  return null;
}

/** Flatten all leaf "row" entries within a section into label/amount items. */
export function extractPnlLineItems(section: PnlReportRow): PnlLineItem[] {
  const lineItems = new Map<
    string,
    { amountCents: number; accountId: string | null }
  >();

  const visit = (row: PnlReportRow) => {
    if (row.rowType?.toLowerCase() === "row") {
      const label = readRowLabel(row);
      const amountCents = readRowAmountCents(row);
      if (label && amountCents !== null && !label.toLowerCase().includes("total")) {
        const accountId = readRowAccountId(row);
        const existing = lineItems.get(label);
        if (existing) {
          existing.amountCents += amountCents;
          if (!existing.accountId && accountId) {
            existing.accountId = accountId;
          }
        } else {
          lineItems.set(label, { amountCents, accountId });
        }
      }
    }

    for (const nested of row.rows) {
      visit(nested);
    }
  };

  for (const row of section.rows) {
    visit(row);
  }

  return Array.from(lineItems.entries())
    .map(([label, item]) => ({
      label,
      amountCents: item.amountCents,
      accountId: item.accountId,
    }))
    .sort((left, right) => right.amountCents - left.amountCents);
}

function flattenRows(rows: PnlReportRow[]): PnlReportRow[] {
  const flattened: PnlReportRow[] = [];
  for (const row of rows) {
    flattened.push(row, ...flattenRows(row.rows));
  }
  return flattened;
}

/**
 * The section's summary total (a "summaryrow" whose label matches one of the
 * keywords), falling back to the first summary row, then to the line-item sum.
 */
export function extractPnlSectionTotalCents(
  section: PnlReportRow,
  summaryKeywords: string[]
): number | null {
  const summaryRows = flattenRows(section.rows).filter(
    (row) => row.rowType?.toLowerCase() === "summaryrow"
  );

  for (const row of summaryRows) {
    const label = readRowLabel(row)?.toLowerCase();
    const amountCents = readRowAmountCents(row);
    if (
      amountCents !== null &&
      label &&
      summaryKeywords.some((keyword) => label.includes(keyword))
    ) {
      return amountCents;
    }
  }

  for (const row of summaryRows) {
    const amountCents = readRowAmountCents(row);
    if (amountCents !== null) {
      return amountCents;
    }
  }

  const lineItems = extractPnlLineItems(section);
  if (lineItems.length === 0) {
    return null;
  }

  return lineItems.reduce((total, item) => total + item.amountCents, 0);
}

/** Best-effort period label from the report fields/titles, e.g. "April 2026". */
export function readPnlPeriodLabel(payload: PnlReportPayload): string | null {
  const periodField =
    payload.fields.find((field) =>
      [field.fieldId, field.description]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes("period"))
    )?.value ?? null;

  if (periodField) {
    return periodField;
  }

  const titledPeriod = [...payload.reportTitles]
    .reverse()
    .find((title) => /\b\d{4}\b/.test(title));

  return titledPeriod ?? payload.reportDate;
}
