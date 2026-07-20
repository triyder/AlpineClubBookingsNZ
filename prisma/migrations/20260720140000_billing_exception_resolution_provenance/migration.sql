-- #2148 (D2): record how a MembershipBillingException reached RESOLVED so a
-- preview-reconciliation resolution is distinguishable from a confirm-run one.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * creates a new enum type and adds one nullable column that references it.
--    Old code keeps working: it never names the enum type nor the new column,
--    and the column is nullable with no default so no backfill runs. New code
--    stamps CONFIRM / PREVIEW_RECONCILE when it resolves an exception.

-- New enum for the resolution-provenance column.
CREATE TYPE "MembershipBillingExceptionResolution" AS ENUM ('CONFIRM', 'PREVIEW_RECONCILE');

-- Nullable provenance column (no default; existing/legacy resolved rows stay
-- NULL, every OPEN row stays NULL). Metadata-only ADD COLUMN, no table rewrite,
-- brief ACCESS EXCLUSIVE lock; MembershipBillingException is a cold
-- membership-billing table (absent from HOT_TABLE_SQL_REGEX).
ALTER TABLE "MembershipBillingException" ADD COLUMN "resolvedVia" "MembershipBillingExceptionResolution";
