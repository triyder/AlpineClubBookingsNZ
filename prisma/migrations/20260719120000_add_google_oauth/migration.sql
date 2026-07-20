-- Google OAuth sign-in via profile-initiated linking (#2035, epic #2030).
-- Additive to password login; merges LAST in the epic lane order.
--
-- Expand-only and old-colour compatible: purely additive — a flagged-off boolean
-- carrying a constant default on the cold single-row (id=default)
-- ClubModuleSettings table, and a NULLABLE column + unique index on Member. The
-- ADD COLUMN googleLogin carries a constant default, so it is a PostgreSQL 11+
-- catalog-only change (no table rewrite, brief ACCESS EXCLUSIVE lock);
-- ClubModuleSettings is not in HOT_TABLE_SQL_REGEX. ADD COLUMN googleSub takes NO
-- default, so it is likewise a metadata-only catalog change even on the hot
-- Member table (no row scan, no rewrite) — flagged by the hot-table regex only
-- because ALTER TABLE names Member. The unique index builds over an all-NULL
-- column (NULLs never collide), so it is a fast, trivially-distinct build that
-- briefly blocks Member writes; switch to CREATE UNIQUE INDEX CONCURRENTLY if
-- Member is very large. No backfill, no provider call, no destructive SQL.
--
-- Old-colour compatible: the previously deployed Prisma client has no
-- `googleLogin` module field and no `Member.googleSub` field and never reads or
-- writes either; the flag defaults OFF so Google sign-in stays disabled through
-- the migrate->cutover window until an admin enables the module AND a member
-- links their account.
--
-- Timestamp note: slotted at 20260719120000 so it sorts AFTER every migration
-- committed on main at merge time (latest was 20260718130000_add_magic_link,
-- #2034) — this child merges LAST in the epic lane.

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN     "googleLogin" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "googleSub" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Member_googleSub_key" ON "Member"("googleSub");
