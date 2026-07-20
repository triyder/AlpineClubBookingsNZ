-- #2147: Annual-subscription billing dedup + void/re-bill support.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds an enum value, two nullable/defaulted columns, and swaps the
--    coverage.subscriptionId UNIQUE for a partial-unique "one ACTIVE claim per
--    subscription" index. Old code keeps working: it never depends on the
--    enum value, ignores the new columns, and cannot create a second coverage
--    row per subscription (that only happens via the new re-bill runtime), so
--    the dropped full-unique constraint is never violated during drain.

-- New terminal charge status for a voided/deleted Xero invoice (row retained
-- for audit). PostgreSQL applies ADD VALUE without a table rewrite.
ALTER TYPE "MembershipSubscriptionChargeStatus" ADD VALUE 'VOIDED';

-- Monotonic re-bill discriminator on the season subscription (default 0).
ALTER TABLE "MemberSubscription" ADD COLUMN "voidGeneration" INTEGER NOT NULL DEFAULT 0;

-- Released-claim marker on coverage (null = active). Never cleared.
ALTER TABLE "MembershipSubscriptionChargeCoverage" ADD COLUMN "releasedAt" TIMESTAMP(3);

-- Replace the plain UNIQUE(subscriptionId) with a partial unique index that
-- constrains only ACTIVE claims, so a retained released row can coexist with a
-- fresh active one. Existing rows are all active (releasedAt IS NULL) and were
-- already unique per subscription, so the partial index builds cleanly. The
-- FK still needs a plain index on subscriptionId once the unique is gone.
DROP INDEX "MembershipSubscriptionChargeCoverage_subscriptionId_key";
CREATE INDEX "MembershipSubscriptionChargeCoverage_subscriptionId_idx" ON "MembershipSubscriptionChargeCoverage"("subscriptionId");
CREATE UNIQUE INDEX "MembershipSubscriptionChargeCoverage_active_subscription_unique" ON "MembershipSubscriptionChargeCoverage"("subscriptionId") WHERE "releasedAt" IS NULL;
