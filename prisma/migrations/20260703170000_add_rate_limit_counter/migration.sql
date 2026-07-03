-- CreateTable
CREATE TABLE "RateLimitCounter" (
    "id" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimitCounter_resetAt_idx" ON "RateLimitCounter"("resetAt");
