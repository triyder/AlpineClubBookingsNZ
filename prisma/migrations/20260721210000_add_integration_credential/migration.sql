-- #2079 (C1): encrypted integration credential store for guided provider setup.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds ONE new standalone table plus its indexes and a compound unique on
--    (provider, key). Purely additive — the previously deployed (old-colour)
--    Prisma client never reads this table, so it keeps working unchanged during
--    migrate -> cutover drain. No enum change, no column drop/alter, no RENAME,
--    no backfill DML, no foreign key, no session-clock write, and no
--    Xero/provider call. The new-colour runtime is the only writer/reader.

-- CreateTable
CREATE TABLE "IntegrationCredential" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "secretSource" TEXT NOT NULL,
    "labelVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCredential_provider_key_key" ON "IntegrationCredential"("provider", "key");

-- CreateIndex
CREATE INDEX "IntegrationCredential_provider_idx" ON "IntegrationCredential"("provider");

-- CreateIndex
CREATE INDEX "IntegrationCredential_updatedAt_idx" ON "IntegrationCredential"("updatedAt");
