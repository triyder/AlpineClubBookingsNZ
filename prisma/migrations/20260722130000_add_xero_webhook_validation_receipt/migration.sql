-- #2081 (C3): intent-to-receive (ITR) receipt sink for provider webhooks.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds ONE new standalone table plus a single-column unique on provider and a
--    default-timestamp column. Purely additive — the previously deployed
--    (old-colour) Prisma client never reads this table, so it keeps working
--    unchanged during migrate -> cutover drain. No enum change, no column
--    drop/alter on an existing table, no RENAME, no backfill DML, no foreign
--    key, no session-clock DML on an existing hot table, and no Xero/provider
--    call. The new-colour runtime is the only writer (the webhook route on a
--    valid ITR ping) and reader (the setup wizard's verify poll + amber badge).
--    The table is brand-new and absent from HOT_TABLE_SQL_REGEX.

-- CreateTable
CREATE TABLE "WebhookValidationReceipt" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "validatedAt" TIMESTAMP(3) NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookValidationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookValidationReceipt_provider_key" ON "WebhookValidationReceipt"("provider");
