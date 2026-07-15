-- Lobby TV Display, consolidated (fork epic #69/#25, ADR-003; issue #86 /
-- LTV-040). The lobby-display feature was built up across six migrations on the
-- feature branch (schema → name granularity → device templateKey → notice →
-- authoring v2 → poll seconds). None ever shipped: the `lobbyDisplay` module
-- flag defaults OFF and no colour has ever run the intermediate churn, so the
-- #86 re-layer collapses them into this ONE migration that creates the final
-- state directly — no DisplayTemplateSource enum, no retired device templateKey
-- column, pollSeconds present from the start.
--
-- Expand-only and old-colour compatible: purely additive (new tables + nullable
-- Lodge columns + a flagged-off boolean carrying a constant default, which is a
-- metadata-only ADD COLUMN on modern Postgres — no table rewrite). The previous
-- colour has no Prisma model field for any of this and never reads or writes it.

-- CreateEnum
CREATE TYPE "DisplayNameGranularity" AS ENUM ('FULL_NAME', 'FIRST_NAME_SURNAME_INITIAL', 'FIRST_NAME_ONLY', 'COUNTS_ONLY');

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN     "lobbyDisplay" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Lodge" ADD COLUMN     "displayConfig" JSONB,
ADD COLUMN     "displayNameGranularity" "DisplayNameGranularity",
ADD COLUMN     "displayNotice" VARCHAR(2000);

-- CreateTable
CREATE TABLE "DisplayLayout" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "bodyHtml" TEXT NOT NULL,
    "defaultCss" TEXT NOT NULL,
    "areas" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisplayLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisplayTemplate" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "layoutId" TEXT NOT NULL,
    "slotContent" JSONB NOT NULL,
    "cssOverrides" TEXT NOT NULL,
    "footerHtml" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisplayTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LodgeDisplayDevice" (
    "id" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "pairingCode" VARCHAR(16),
    "pairingCodeExpiresAt" TIMESTAMP(3),
    "tokenHash" TEXT,
    "templateId" TEXT,
    "pollSeconds" INTEGER,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LodgeDisplayDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DisplayLayout_key_key" ON "DisplayLayout"("key");

-- CreateIndex
CREATE UNIQUE INDEX "DisplayTemplate_key_key" ON "DisplayTemplate"("key");

-- CreateIndex
CREATE INDEX "DisplayTemplate_layoutId_idx" ON "DisplayTemplate"("layoutId");

-- CreateIndex
CREATE UNIQUE INDEX "LodgeDisplayDevice_tokenHash_key" ON "LodgeDisplayDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "LodgeDisplayDevice_lodgeId_idx" ON "LodgeDisplayDevice"("lodgeId");

-- CreateIndex
CREATE INDEX "LodgeDisplayDevice_templateId_idx" ON "LodgeDisplayDevice"("templateId");

-- AddForeignKey
ALTER TABLE "DisplayTemplate" ADD CONSTRAINT "DisplayTemplate_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "DisplayLayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LodgeDisplayDevice" ADD CONSTRAINT "LodgeDisplayDevice_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LodgeDisplayDevice" ADD CONSTRAINT "LodgeDisplayDevice_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DisplayTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
