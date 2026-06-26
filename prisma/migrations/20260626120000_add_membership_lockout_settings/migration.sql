-- Single-row settings for the membership booking lockout (block members with an
-- unpaid annual subscription). Same shape as MembershipNominationSettings.
-- "enabled" defaults to true so existing installs keep the current behaviour.
-- "financialYearEndMonthOverride" is nullable: null follows the connected Xero
-- organisation's accounting financial year, a value (1-12) overrides it for the
-- membership subscription year.
CREATE TABLE "MembershipLockoutSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "financialYearEndMonthOverride" INTEGER,
    "textFallbackEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipLockoutSettings_pkey" PRIMARY KEY ("id")
);
