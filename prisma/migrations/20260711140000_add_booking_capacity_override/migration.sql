-- Persisted capacity override (#1771): nullable who/when columns on Booking.
-- Set when a booking was deliberately admitted above the lodge ceiling via an
-- explicit admin over-capacity confirm; read by the payment-time capacity
-- re-checks so a priced overridden booking is never cancelled/blocked/bumped.
-- Expand-only: nullable ADD COLUMNs, an index over the new all-NULL column,
-- and a SET NULL FK to Member.

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "capacityOverriddenAt" TIMESTAMP(3),
ADD COLUMN     "capacityOverriddenByMemberId" TEXT;

-- CreateIndex
CREATE INDEX "Booking_capacityOverriddenByMemberId_idx" ON "Booking"("capacityOverriddenByMemberId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_capacityOverriddenByMemberId_fkey" FOREIGN KEY ("capacityOverriddenByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
