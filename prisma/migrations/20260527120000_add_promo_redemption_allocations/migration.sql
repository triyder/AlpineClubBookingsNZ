-- Track the member beneficiaries behind each booking-level promo redemption.
-- Existing redemption rows are backfilled as one allocation for the recorded
-- booking member because historical guest-level beneficiaries cannot be
-- reconstructed safely.

CREATE TABLE "PromoRedemptionAllocation" (
    "id" TEXT NOT NULL,
    "promoRedemptionId" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "discountCents" INTEGER NOT NULL,
    "freeNightsUsed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoRedemptionAllocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PromoRedemptionAllocation_promoRedemptionId_memberId_key"
ON "PromoRedemptionAllocation"("promoRedemptionId", "memberId");

CREATE UNIQUE INDEX "PromoRedemptionAllocation_promoCodeId_bookingId_memberId_key"
ON "PromoRedemptionAllocation"("promoCodeId", "bookingId", "memberId");

CREATE INDEX "PromoRedemptionAllocation_promoCodeId_idx"
ON "PromoRedemptionAllocation"("promoCodeId");

CREATE INDEX "PromoRedemptionAllocation_memberId_idx"
ON "PromoRedemptionAllocation"("memberId");

CREATE INDEX "PromoRedemptionAllocation_bookingId_idx"
ON "PromoRedemptionAllocation"("bookingId");

ALTER TABLE "PromoRedemptionAllocation"
ADD CONSTRAINT "PromoRedemptionAllocation_promoRedemptionId_fkey"
FOREIGN KEY ("promoRedemptionId") REFERENCES "PromoRedemption"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PromoRedemptionAllocation"
ADD CONSTRAINT "PromoRedemptionAllocation_promoCodeId_fkey"
FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PromoRedemptionAllocation"
ADD CONSTRAINT "PromoRedemptionAllocation_bookingId_fkey"
FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PromoRedemptionAllocation"
ADD CONSTRAINT "PromoRedemptionAllocation_memberId_fkey"
FOREIGN KEY ("memberId") REFERENCES "Member"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "PromoRedemptionAllocation" (
    "id",
    "promoRedemptionId",
    "promoCodeId",
    "bookingId",
    "memberId",
    "discountCents",
    "freeNightsUsed",
    "createdAt"
)
SELECT
    gen_random_uuid()::text,
    "id",
    "promoCodeId",
    "bookingId",
    "memberId",
    "discountCents",
    COALESCE("freeNightsUsed", 0),
    "createdAt"
FROM "PromoRedemption"
ON CONFLICT ("promoRedemptionId", "memberId") DO NOTHING;

-- Keep old app colors blue/green-compatible during the deploy window. The old
-- runtime only writes PromoRedemption, so this trigger creates or refreshes the
-- one-booker allocation that old code semantically represented.
CREATE OR REPLACE FUNCTION "sync_promo_redemption_allocation_from_redemption"()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO "PromoRedemptionAllocation" (
        "id",
        "promoRedemptionId",
        "promoCodeId",
        "bookingId",
        "memberId",
        "discountCents",
        "freeNightsUsed",
        "createdAt"
    )
    VALUES (
        gen_random_uuid()::text,
        NEW."id",
        NEW."promoCodeId",
        NEW."bookingId",
        NEW."memberId",
        NEW."discountCents",
        COALESCE(NEW."freeNightsUsed", 0),
        NEW."createdAt"
    )
    ON CONFLICT ("promoRedemptionId", "memberId") DO UPDATE SET
        "promoCodeId" = EXCLUDED."promoCodeId",
        "bookingId" = EXCLUDED."bookingId",
        "discountCents" = EXCLUDED."discountCents",
        "freeNightsUsed" = EXCLUDED."freeNightsUsed";

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PromoRedemption_sync_allocation_insert"
AFTER INSERT ON "PromoRedemption"
FOR EACH ROW EXECUTE FUNCTION "sync_promo_redemption_allocation_from_redemption"();

CREATE TRIGGER "PromoRedemption_sync_allocation_update"
AFTER UPDATE OF "promoCodeId", "bookingId", "memberId", "discountCents", "freeNightsUsed"
ON "PromoRedemption"
FOR EACH ROW EXECUTE FUNCTION "sync_promo_redemption_allocation_from_redemption"();

UPDATE "PromoCode" AS pc
SET "currentRedemptions" = COALESCE(counts."allocationCount", 0)
FROM (
    SELECT "promoCodeId", COUNT(*)::INTEGER AS "allocationCount"
    FROM "PromoRedemptionAllocation"
    GROUP BY "promoCodeId"
) AS counts
WHERE pc."id" = counts."promoCodeId";

UPDATE "PromoCode" AS pc
SET "currentRedemptions" = 0
WHERE NOT EXISTS (
    SELECT 1
    FROM "PromoRedemptionAllocation" pra
    WHERE pra."promoCodeId" = pc."id"
);
