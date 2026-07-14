CREATE TABLE "PublicContentSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "membershipTypes" BOOLEAN NOT NULL DEFAULT false,
    "entranceFees" BOOLEAN NOT NULL DEFAULT false,
    "hutFees" BOOLEAN NOT NULL DEFAULT false,
    "bookingPolicySummary" BOOLEAN NOT NULL DEFAULT false,
    "cancellationPolicy" BOOLEAN NOT NULL DEFAULT false,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PublicContentSettings_pkey" PRIMARY KEY ("id")
);
