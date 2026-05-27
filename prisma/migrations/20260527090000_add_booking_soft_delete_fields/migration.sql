ALTER TABLE "Booking"
ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "deletedById" TEXT,
ADD COLUMN "deletedReason" VARCHAR(500);

CREATE INDEX "Booking_deletedById_idx" ON "Booking"("deletedById");
CREATE INDEX "Booking_deletedAt_idx" ON "Booking"("deletedAt");
CREATE INDEX "Booking_status_deletedAt_updatedAt_idx" ON "Booking"("status", "deletedAt", "updatedAt");
CREATE INDEX "Booking_status_deletedAt_checkIn_checkOut_idx" ON "Booking"("status", "deletedAt", "checkIn", "checkOut");

ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_deletedById_fkey"
FOREIGN KEY ("deletedById") REFERENCES "Member"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
