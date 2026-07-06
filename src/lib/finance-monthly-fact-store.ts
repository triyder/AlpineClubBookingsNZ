/**
 * Storage for FinanceAccountMonthlyBalance — the monthly per-account fact
 * table the finance dashboard reads.
 *
 * Writes are whole-window replacements: a sync (or backfill chunk) that pulled
 * months M1..Mn atomically deletes every stored row for those months and
 * recreates them from the pulled report. That makes re-runs idempotent and
 * means accounts that disappear from a re-pulled month (a late Xero edit
 * zeroing them out) are removed rather than left stale. Months outside the
 * pulled window are never touched.
 */

import { FinanceMonthlyStatementKind, FinanceSnapshotType } from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";
import {
  isMonthKey,
  parseFinanceChartOfAccountsContext,
  type FinanceMonthlyChartContext,
  type FinanceMonthlyFactRowInput,
} from "@/lib/finance-monthly-facts";
import {
  DEFAULT_FINANCE_SNAPSHOT_SCOPE,
  listFinanceSnapshots,
} from "@/lib/finance-sync-storage";
import { prisma } from "@/lib/prisma";

export const DEFAULT_FINANCE_MONTHLY_FACT_SCOPE = "default";

export interface ReplaceMonthlyFactsInput {
  statementKind: FinanceMonthlyStatementKind;
  /** Month keys ("YYYY-MM") covered by the pulled report window. */
  months: string[];
  rows: FinanceMonthlyFactRowInput[];
  sourceReport: string;
  scope?: string;
  syncRunId?: string | null;
  currency?: string | null;
  syncedAt?: Date;
}

export interface ReplaceMonthlyFactsResult {
  monthCount: number;
  deletedCount: number;
  createdCount: number;
}

export interface FinanceMonthlyFactRecord {
  statementKind: FinanceMonthlyStatementKind;
  /** Month key, "YYYY-MM". */
  month: string;
  accountCode: string;
  accountId: string | null;
  accountName: string | null;
  accountType: string | null;
  accountClass: string | null;
  amountCents: number;
  currency: string | null;
  isProvisional: boolean;
  sourceReport: string;
  syncedAt: Date;
}

function normalizeScope(scope: string | null | undefined): string {
  const trimmed = scope?.trim();
  return trimmed ? trimmed : DEFAULT_FINANCE_MONTHLY_FACT_SCOPE;
}

/**
 * Load the latest stored chart-of-accounts snapshot as the AccountID lookup
 * fact extraction needs (code, name, type, class per account). The chart
 * dataset runs earlier in the same sync, so this is at most one run stale.
 */
export async function loadFinanceMonthlyChartContext(): Promise<FinanceMonthlyChartContext> {
  const snapshots = await listFinanceSnapshots({
    snapshotType: FinanceSnapshotType.CHART_OF_ACCOUNTS,
    scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
    limit: 1,
  });

  return parseFinanceChartOfAccountsContext(snapshots[0]?.payload);
}

function monthKeyToDate(month: string, fieldName: string): Date {
  if (!isMonthKey(month)) {
    throw new Error(`${fieldName} must be a YYYY-MM month key, got "${month}"`);
  }

  return parseDateOnly(`${month}-01`);
}

function monthKeyFromDate(month: Date): string {
  return month.toISOString().slice(0, 7);
}

function assertReplaceInput(input: ReplaceMonthlyFactsInput): void {
  if (input.months.length === 0) {
    throw new Error("replaceMonthlyFacts requires at least one month");
  }
  if (!input.sourceReport.trim()) {
    throw new Error("sourceReport is required");
  }

  const monthSet = new Set(input.months);
  for (const row of input.rows) {
    if (!monthSet.has(row.month)) {
      throw new Error(
        `Fact row month ${row.month} is outside the pulled window (${input.months.join(", ")})`
      );
    }
    if (!row.accountCode.trim()) {
      throw new Error("Fact rows require a non-empty accountCode");
    }
    if (!Number.isInteger(row.amountCents)) {
      throw new Error(
        `Fact row ${row.month}/${row.accountCode} has a non-integer amountCents`
      );
    }
  }
}

export async function replaceMonthlyFacts(
  input: ReplaceMonthlyFactsInput
): Promise<ReplaceMonthlyFactsResult> {
  assertReplaceInput(input);

  const scope = normalizeScope(input.scope);
  const monthDates = input.months.map((month) => monthKeyToDate(month, "months[]"));
  const syncedAt = input.syncedAt ?? new Date();

  const [deleted, created] = await prisma.$transaction([
    prisma.financeAccountMonthlyBalance.deleteMany({
      where: {
        statementKind: input.statementKind,
        scope,
        month: { in: monthDates },
      },
    }),
    prisma.financeAccountMonthlyBalance.createMany({
      data: input.rows.map((row) => ({
        statementKind: input.statementKind,
        scope,
        month: monthKeyToDate(row.month, "rows[].month"),
        accountCode: row.accountCode,
        accountId: row.accountId,
        accountName: row.accountName,
        accountType: row.accountType,
        accountClass: row.accountClass,
        amountCents: row.amountCents,
        currency: input.currency ?? null,
        isProvisional: row.isProvisional,
        sourceReport: input.sourceReport.trim(),
        syncRunId: input.syncRunId ?? null,
        syncedAt,
      })),
    }),
  ]);

  return {
    monthCount: input.months.length,
    deletedCount: deleted.count,
    createdCount: created.count,
  };
}

export async function listMonthlyFacts(input: {
  statementKind: FinanceMonthlyStatementKind;
  /** Inclusive month-key range, e.g. fromMonth "2025-04", toMonth "2026-03". */
  fromMonth: string;
  toMonth: string;
  scope?: string;
}): Promise<FinanceMonthlyFactRecord[]> {
  const fromDate = monthKeyToDate(input.fromMonth, "fromMonth");
  const toDate = monthKeyToDate(input.toMonth, "toMonth");
  if (fromDate > toDate) {
    throw new Error("fromMonth must not be after toMonth");
  }

  const records = await prisma.financeAccountMonthlyBalance.findMany({
    where: {
      statementKind: input.statementKind,
      scope: normalizeScope(input.scope),
      month: { gte: fromDate, lte: toDate },
    },
    orderBy: [{ month: "asc" }, { accountCode: "asc" }],
  });

  return records.map((record) => ({
    statementKind: record.statementKind,
    month: monthKeyFromDate(record.month),
    accountCode: record.accountCode,
    accountId: record.accountId,
    accountName: record.accountName,
    accountType: record.accountType,
    accountClass: record.accountClass,
    amountCents: record.amountCents,
    currency: record.currency,
    isProvisional: record.isProvisional,
    sourceReport: record.sourceReport,
    syncedAt: record.syncedAt,
  }));
}
