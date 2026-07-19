-- Per-member post-login landing preference (#2090). Additive and expand-only:
-- a new enum type plus a NULLABLE column (no default) on Member. NULL means
-- "follow the role default" — members with admin access land on their first
-- accessible admin page, everyone else on /dashboard — so no existing row's
-- behaviour changes on migrate; the changed admin default lives entirely in the
-- application redirect resolver, not in stored data.
--
-- Old-colour compatible: the previously deployed Prisma client has no
-- `Member.postLoginLanding` field and never reads or writes it. CREATE TYPE
-- registers a new enum in the catalog and touches no table. The Member ADD
-- COLUMN takes NO default, so it is a metadata-only catalog change (no row scan,
-- no table rewrite) even though ALTER TABLE names the hot Member table — it is
-- flagged by the hot-table regex only for naming Member. No backfill, no
-- provider call, no destructive SQL. Safe at any traffic level.
--
-- Timestamp note: slotted at 20260719150000 so it sorts AFTER every migration
-- committed on main at authoring time (latest was
-- 20260719140000_annual_fee_age_tier).

-- CreateEnum
CREATE TYPE "PostLoginLanding" AS ENUM ('MEMBER_DASHBOARD', 'ADMIN_DASHBOARD');

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "postLoginLanding" "PostLoginLanding";
