-- #2211 (epic #2094 C3): AI help assistant metering, spend control, and module flag.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * creates two brand-new cold metering tables (AiAssistantUsageMonthly,
--    AiAssistantUsageEvent) and one cold settings singleton
--    (AiAssistantSettings), all with plain btree indexes and NO foreign keys
--    (memberId / updatedByMemberId are deliberately plain strings so this
--    metering never blocks a Member delete or trips the FK gate in
--    HOT_TABLE_SQL_REGEX);
--  * adds ONE nullable-defaulted boolean column to the cold ClubModuleSettings
--    catalog singleton: ADD COLUMN "aiAssistant" NOT NULL DEFAULT false. A
--    metadata-only ADD COLUMN with a constant default — no table rewrite.
--  Purely additive / expand-safe: the previously deployed (old-colour) Prisma
--  client has no AiAssistant* models and never reads the new column (every
--  ClubModuleSettings read is narrowed by CLUB_MODULE_SETTINGS_COLUMN_SELECT),
--  so it keeps working unchanged during migrate -> cutover drain. No enum
--  change, no DROP, no RENAME, no ALTER COLUMN TYPE / SET NOT NULL on existing
--  data, no backfill DML, no session-clock DML, and no provider call. All three
--  new tables are absent from HOT_TABLE_SQL_REGEX, and ClubModuleSettings is a
--  cold catalog table. The new-colour runtime is the only reader/writer.

-- CreateTable
CREATE TABLE "AiAssistantUsageMonthly" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAssistantUsageMonthly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAssistantUsageEvent" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "memberId" TEXT,
    "surface" TEXT NOT NULL,
    "pathname" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "statusCode" INTEGER,
    "durationMs" INTEGER,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "questionChars" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAssistantUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAssistantSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "monthlyBudgetCents" INTEGER NOT NULL DEFAULT 1000,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByMemberId" TEXT,

    CONSTRAINT "AiAssistantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiAssistantUsageMonthly_month_key" ON "AiAssistantUsageMonthly"("month");

-- CreateIndex
CREATE INDEX "AiAssistantUsageEvent_month_idx" ON "AiAssistantUsageEvent"("month");

-- CreateIndex
CREATE INDEX "AiAssistantUsageEvent_createdAt_idx" ON "AiAssistantUsageEvent"("createdAt");

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN "aiAssistant" BOOLEAN NOT NULL DEFAULT false;
