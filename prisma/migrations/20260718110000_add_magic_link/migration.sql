-- Email magic-link sign-in (#2034, epic #2030). Additive to password login.
--
-- Expand-only and old-colour compatible: purely additive (a new table + a
-- flagged-off boolean carrying a constant default, which is a metadata-only
-- ADD COLUMN on modern Postgres — no table rewrite). The previous colour has no
-- Prisma model field for `magicLink` or MagicLinkToken and never reads or writes
-- either.
--
-- Timestamp note: slotted at 20260718110000 so it sorts AFTER every migration
-- committed on main at planning time (latest was 20260717220000) AND after any
-- 20260718_10xxxx slot the sibling security-page child (#2033) may take, since
-- #2034 merges SECOND in the epic lane order.

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN     "magicLink" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MagicLinkToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MagicLinkToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MagicLinkToken_tokenHash_key" ON "MagicLinkToken"("tokenHash");

-- CreateIndex
CREATE INDEX "MagicLinkToken_memberId_idx" ON "MagicLinkToken"("memberId");

-- AddForeignKey
ALTER TABLE "MagicLinkToken" ADD CONSTRAINT "MagicLinkToken_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
