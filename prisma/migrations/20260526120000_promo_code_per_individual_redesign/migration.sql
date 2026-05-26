-- Promo code per-individual redesign.
--
-- Renames the existing free-nights and redemption-cap columns to make their
-- semantics explicit (per-individual rather than per-booking), replaces the
-- singleUse boolean with an explicit maxUsesPerMember integer, and adds
-- per-booking guest caps, an overall unique-members cap, a per-night value
-- cap, and an optional member-guests-only flag.

-- 1. Rename free-nights column. The value is preserved as the per-individual
--    amount and continues to act as the lifetime cap per booker.
ALTER TABLE "PromoCode" RENAME COLUMN "freeNights" TO "freeNightsPerIndividual";

-- 2. Rename the global redemption cap so its scope (total across all members)
--    is clear next to the new maxUniqueMembersTotal cap.
ALTER TABLE "PromoCode" RENAME COLUMN "maxRedemptions" TO "maxRedemptionsTotal";

-- 3. Replace singleUse boolean with maxUsesPerMember integer.
--    singleUse=true backfills to 1; singleUse=false backfills to NULL (unlimited).
ALTER TABLE "PromoCode" ADD COLUMN "maxUsesPerMember" INTEGER;
UPDATE "PromoCode" SET "maxUsesPerMember" = 1 WHERE "singleUse" = true;
ALTER TABLE "PromoCode" DROP COLUMN "singleUse";

-- 4. Add new per-booking and overall caps and the value/eligibility controls.
ALTER TABLE "PromoCode" ADD COLUMN "maxGuestsPerBooking" INTEGER;
ALTER TABLE "PromoCode" ADD COLUMN "maxUniqueMembersTotal" INTEGER;
ALTER TABLE "PromoCode" ADD COLUMN "memberGuestsOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PromoCode" ADD COLUMN "maxNightlyValueCents" INTEGER;

-- 5. PromoRedemption gains an eligibleGuestCount column for reporting how
--    many guests the promo touched on each booking.
ALTER TABLE "PromoRedemption" ADD COLUMN "eligibleGuestCount" INTEGER;
