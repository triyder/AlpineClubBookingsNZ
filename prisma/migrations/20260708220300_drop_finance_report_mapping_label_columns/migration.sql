-- Contract migration: drop the value-dead FinanceReportCategoryMapping label columns.
--
-- `sectionLabel` and `lineLabel` backed the legacy text-label P&L fallback
-- matching, which was removed in 20260629000000_add_finance_report_category_subtype
-- (PR #938): P&L lines now match report groups by Xero account code only. The app
-- logic has ignored these columns' VALUES since, and a read-only production count
-- (#1532) confirmed 31 rows with ZERO non-NULL label values, so this drop loses no
-- data.
--
-- Blue/green caveat: the columns stayed in the Prisma model until this same
-- release, and Prisma emits explicit column lists, so the previously-deployed
-- colour's client still SELECTs these columns by name. Its finance-dashboard /
-- mappings-admin READ queries therefore error between migrate and cutover. Deploy
-- only with the ALLOW_BREAKING override and old traffic idle or routed to the new
-- runtime -- see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the full record.
--
-- Drop the composite index explicitly first. DROP COLUMN would remove it
-- implicitly, but the explicit statement documents intent and keeps the index
-- teardown visible in the migration/drift diff.

-- DropIndex
DROP INDEX "FinanceReportCategoryMapping_sectionLabel_lineLabel_idx";

-- AlterTable
ALTER TABLE "FinanceReportCategoryMapping" DROP COLUMN "sectionLabel",
DROP COLUMN "lineLabel";
