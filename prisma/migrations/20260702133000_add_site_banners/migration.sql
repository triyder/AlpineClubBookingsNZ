-- CreateEnum
CREATE TYPE "SiteBannerPriority" AS ENUM ('URGENT', 'WARNING', 'NOTIFY');

-- CreateTable
CREATE TABLE "SiteBanner" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "priority" "SiteBannerPriority" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByMemberId" TEXT,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteBanner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteBanner_active_startDate_endDate_idx" ON "SiteBanner"("active", "startDate", "endDate");
