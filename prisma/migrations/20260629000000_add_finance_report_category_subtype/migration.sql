-- Add an optional free-text subtype used to group finance report categories into
-- labelled sub-sections (with sub-totals) on the finance dashboard. Additive only.
ALTER TABLE "FinanceReportCategory" ADD COLUMN "subtype" VARCHAR(120);
