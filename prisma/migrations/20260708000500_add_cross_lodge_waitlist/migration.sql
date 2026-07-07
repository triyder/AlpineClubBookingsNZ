-- CreateEnum
CREATE TYPE "WaitlistCrossLodgeOrder" AS ENUM ('OWN_LODGE_FIRST', 'MERGED');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "waitlistOfferedLodgeId" TEXT,
ADD COLUMN     "waitlistOfferedPriceCents" INTEGER;

-- AlterTable
ALTER TABLE "BookingDefaults" ADD COLUMN     "waitlistCrossLodgeOrder" "WaitlistCrossLodgeOrder" NOT NULL DEFAULT 'OWN_LODGE_FIRST';

-- CreateTable
CREATE TABLE "BookingWaitlistAlternateLodge" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingWaitlistAlternateLodge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingWaitlistAlternateLodge_lodgeId_idx" ON "BookingWaitlistAlternateLodge"("lodgeId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingWaitlistAlternateLodge_bookingId_lodgeId_key" ON "BookingWaitlistAlternateLodge"("bookingId", "lodgeId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_waitlistOfferedLodgeId_fkey" FOREIGN KEY ("waitlistOfferedLodgeId") REFERENCES "Lodge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingWaitlistAlternateLodge" ADD CONSTRAINT "BookingWaitlistAlternateLodge_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingWaitlistAlternateLodge" ADD CONSTRAINT "BookingWaitlistAlternateLodge_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

