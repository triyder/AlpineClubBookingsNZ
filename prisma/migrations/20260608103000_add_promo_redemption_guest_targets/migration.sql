CREATE TABLE IF NOT EXISTS "PromoRedemptionGuestTarget" (
    "id" TEXT NOT NULL,
    "promoRedemptionId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "bookingGuestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoRedemptionGuestTarget_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'PromoRedemptionGuestTarget_promoRedemptionId_fkey'
    ) THEN
        ALTER TABLE "PromoRedemptionGuestTarget"
            ADD CONSTRAINT "PromoRedemptionGuestTarget_promoRedemptionId_fkey"
            FOREIGN KEY ("promoRedemptionId") REFERENCES "PromoRedemption"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'PromoRedemptionGuestTarget_bookingId_fkey'
    ) THEN
        ALTER TABLE "PromoRedemptionGuestTarget"
            ADD CONSTRAINT "PromoRedemptionGuestTarget_bookingId_fkey"
            FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'PromoRedemptionGuestTarget_bookingGuestId_fkey'
    ) THEN
        ALTER TABLE "PromoRedemptionGuestTarget"
            ADD CONSTRAINT "PromoRedemptionGuestTarget_bookingGuestId_fkey"
            FOREIGN KEY ("bookingGuestId") REFERENCES "BookingGuest"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "PromoRedemptionGuestTarget_promoRedemptionId_bookingGuestId_key"
    ON "PromoRedemptionGuestTarget"("promoRedemptionId", "bookingGuestId");

CREATE INDEX IF NOT EXISTS "PromoRedemptionGuestTarget_bookingId_idx"
    ON "PromoRedemptionGuestTarget"("bookingId");

CREATE INDEX IF NOT EXISTS "PromoRedemptionGuestTarget_bookingGuestId_idx"
    ON "PromoRedemptionGuestTarget"("bookingGuestId");
