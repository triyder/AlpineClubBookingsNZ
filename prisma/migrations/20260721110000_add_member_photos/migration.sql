-- MP1 (#189), epic #171 — member-photos schema foundation. EXPAND-ONLY.
--
-- Every statement is additive and old-colour compatible:
--   * CREATE TYPE "MediaImageKind" — a brand-new enum, referenced by nothing the
--     previously deployed Prisma client knows about.
--   * ALTER TABLE "Member" ADD COLUMN photoImageId / photoUpdatedAt /
--     photoUpdatedByMemberId — three nullable columns with NO default, so each is
--     a PostgreSQL catalog-only change (no table rewrite, no row scan), a brief
--     ACCESS EXCLUSIVE lock. Existing rows read as NULL (no photo).
--   * ALTER TABLE "MediaImage" ADD COLUMN kind — NOT NULL DEFAULT 'CONTENT'. The
--     default is a CONSTANT, so on PostgreSQL 11+ this is a metadata-only change:
--     existing rows are reported as CONTENT without being rewritten. This is the
--     only backfill and it is the constant default — every pre-existing image is
--     therefore CONTENT and still visible in the website media picker.
--   * Two plain (non-CONCURRENT) btree indexes on all-NULL / uniform columns and
--     one nullable FK ON DELETE SET NULL — the index builds and the FK ADD
--     CONSTRAINT validate trivially (all-NULL photoImageId) under brief locks at
--     these tables' sizes.
--
-- Old-colour compatible: the previously deployed client has no field for any of
-- these columns and never reads or writes them; MediaImage rows keep defaulting
-- to CONTENT so the old colour's media picker (unfiltered) and the new colour's
-- picker (kind = CONTENT) surface the identical set during migrate->cutover. No
-- destructive SQL, no provider calls, no hot-row rewrite.

-- CreateEnum
CREATE TYPE "MediaImageKind" AS ENUM ('CONTENT', 'MEMBER_PHOTO');

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "photoImageId" TEXT,
ADD COLUMN     "photoUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "photoUpdatedByMemberId" TEXT;

-- AlterTable
ALTER TABLE "MediaImage" ADD COLUMN     "kind" "MediaImageKind" NOT NULL DEFAULT 'CONTENT';

-- CreateIndex
CREATE INDEX "Member_photoImageId_idx" ON "Member"("photoImageId");

-- CreateIndex
CREATE INDEX "MediaImage_kind_idx" ON "MediaImage"("kind");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_photoImageId_fkey" FOREIGN KEY ("photoImageId") REFERENCES "MediaImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
