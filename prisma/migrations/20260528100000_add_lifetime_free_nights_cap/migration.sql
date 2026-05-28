-- Split per-booking and lifetime free-nights caps on PromoCode.
-- The legacy freeNightsPerIndividual field doubled as both the per-eligible-guest
-- per-booking cap and the per-member lifetime cap. This migration introduces
-- lifetimeFreeNightsCap and seeds it from the existing value so behaviour for
-- current FREE_NIGHTS codes is unchanged.

ALTER TABLE "PromoCode" ADD COLUMN "lifetimeFreeNightsCap" INTEGER;

UPDATE "PromoCode"
SET "lifetimeFreeNightsCap" = "freeNightsPerIndividual"
WHERE "type" = 'FREE_NIGHTS'
  AND "freeNightsPerIndividual" IS NOT NULL;
