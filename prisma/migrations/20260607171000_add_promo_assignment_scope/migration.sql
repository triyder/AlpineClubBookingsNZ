ALTER TABLE "PromoCode"
    ADD COLUMN IF NOT EXISTS "assignedMembersOnlyOwnNights" BOOLEAN NOT NULL DEFAULT true;
