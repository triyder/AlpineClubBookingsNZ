-- Finance dashboard monthly fact table (#15/#16 rebuild, phase A).
--
-- The dashboard previously aggregated cumulative month-to-date P&L snapshots
-- (one per daily sync), which multi-counted amounts. This table stores the
-- corrected shape the dashboard will read from: one row per (statement kind,
-- month, Xero account code), replaced idempotently from multi-period Xero
-- reports (12 months per sync call). Expand-only: no existing objects change
-- other than two appended FinanceSnapshotType values for the raw multi-period
-- report snapshots the fact rows are derived from.

-- 1. New snapshot types for the raw 12-month report payloads (kept so fact
--    rows can be re-derived without a Xero call). AFTER placement keeps the
--    enum's value order identical to schema.prisma for the drift gate.
ALTER TYPE "FinanceSnapshotType" ADD VALUE 'PROFIT_AND_LOSS_BY_MONTH' AFTER 'PROFIT_AND_LOSS_MONTHLY';
ALTER TYPE "FinanceSnapshotType" ADD VALUE 'BALANCE_SHEET_BY_MONTH' AFTER 'BALANCE_SHEET';

-- 2. Statement-kind discriminator: PROFIT_AND_LOSS rows are the month's net
--    activity; BALANCE_SHEET rows are the closing month-end position.
CREATE TYPE "FinanceMonthlyStatementKind" AS ENUM ('PROFIT_AND_LOSS', 'BALANCE_SHEET');

-- 3. The fact table. "month" is always the first day of the month (NZ
--    date-only); "accountCode" is the normalized upper-case Xero GL code so it
--    joins directly to FinanceReportCategoryMapping.accountCode.
CREATE TABLE "FinanceAccountMonthlyBalance" (
    "id" TEXT NOT NULL,
    "statementKind" "FinanceMonthlyStatementKind" NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'default',
    "month" DATE NOT NULL,
    "accountCode" VARCHAR(40) NOT NULL,
    "accountId" TEXT,
    "accountName" VARCHAR(200),
    "accountType" VARCHAR(40),
    "accountClass" VARCHAR(20),
    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(8),
    "isProvisional" BOOLEAN NOT NULL DEFAULT false,
    "sourceReport" VARCHAR(60) NOT NULL,
    "syncRunId" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceAccountMonthlyBalance_pkey" PRIMARY KEY ("id")
);

-- 4. Upsert key + read paths (dashboard queries by kind+month range, category
--    joins by accountCode, sync provenance by run).
CREATE UNIQUE INDEX "FinanceAccountMonthlyBalance_statementKind_scope_month_acco_key" ON "FinanceAccountMonthlyBalance"("statementKind", "scope", "month", "accountCode");

CREATE INDEX "FinanceAccountMonthlyBalance_statementKind_month_idx" ON "FinanceAccountMonthlyBalance"("statementKind", "month");

CREATE INDEX "FinanceAccountMonthlyBalance_accountCode_month_idx" ON "FinanceAccountMonthlyBalance"("accountCode", "month");

CREATE INDEX "FinanceAccountMonthlyBalance_syncRunId_idx" ON "FinanceAccountMonthlyBalance"("syncRunId");

-- 5. Same SetNull linkage to sync runs as FinanceSnapshot.
ALTER TABLE "FinanceAccountMonthlyBalance" ADD CONSTRAINT "FinanceAccountMonthlyBalance_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "FinanceSyncRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
