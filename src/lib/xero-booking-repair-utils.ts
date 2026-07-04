// Pure JSON/date/amount readers and small helpers for the booking-vs-Xero
// repair tool. Extracted verbatim from xero-booking-repair.ts (#1208 item 2).
// Per #1208, this file's readJson* guards are intentionally kept local (NOT
// merged into @/lib/xero-json) to preserve behavior.

export function makeLocalKey(localModel: string, localId: string) {
  return `${localModel}:${localId}`;
}

export function toIsoDate(value: Date) {
  return value.toISOString();
}

export function toDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function readJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function readJsonString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readJsonNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function dollarsToCents(value: unknown): number | null {
  const amount = readJsonNumber(value);
  return amount === null ? null : Math.round(amount * 100);
}

function readLineItemTotalCents(lineItems: unknown): number | null {
  const items = readJsonArray(lineItems);
  if (items.length === 0) {
    return null;
  }

  let totalCents = 0;
  let foundAmount = false;
  for (const item of items) {
    const record = readJsonRecord(item);
    if (!record) {
      continue;
    }
    const unitAmountCents = dollarsToCents(record.unitAmount);
    if (unitAmountCents === null) {
      continue;
    }
    const quantity = readJsonNumber(record.quantity) ?? 1;
    totalCents += Math.round(unitAmountCents * quantity);
    foundAmount = true;
  }

  return foundAmount ? totalCents : null;
}

function readDocumentAmountCents(document: unknown): number | null {
  const record = readJsonRecord(document);
  if (!record) {
    return null;
  }

  return dollarsToCents(record.total) ?? readLineItemTotalCents(record.lineItems);
}

function readFirstDocumentAmountCents(documents: unknown): number | null {
  const firstDocument = readJsonArray(documents)[0];
  return firstDocument ? readDocumentAmountCents(firstDocument) : null;
}

export function readStoredXeroAmountCents(payload: unknown): number | null {
  const record = readJsonRecord(payload);
  if (!record) {
    return null;
  }

  const directAmount = readJsonNumber(record.amountCents);
  if (directAmount !== null) {
    return directAmount;
  }

  const refundAmount = readJsonNumber(record.refundAmountCents);
  if (refundAmount !== null) {
    return refundAmount;
  }

  const priceDiffCents = readJsonNumber(record.priceDiffCents);
  const changeFeeCents = readJsonNumber(record.changeFeeCents);
  if (priceDiffCents !== null || changeFeeCents !== null) {
    return (priceDiffCents ?? 0) + (changeFeeCents ?? 0);
  }

  return (
    readFirstDocumentAmountCents(record.invoices) ??
    readFirstDocumentAmountCents(record.creditNotes) ??
    readDocumentAmountCents(record.invoice) ??
    readDocumentAmountCents(record.creditNote)
  );
}

export function startOfDay(value: Date) {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

export function createCountMap(items: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return Object.fromEntries(
    Array.from(counts.entries()).sort(([left], [right]) => left.localeCompare(right))
  );
}
