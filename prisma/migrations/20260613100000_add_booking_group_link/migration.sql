-- Split-booking group link (issue #738).
-- A mixed member/non-member party is stored as two linked bookings: a member
-- booking paid up front that holds capacity (the parent) and a provisional
-- non-member booking that holds nothing (the child, parentBookingId = parent).
ALTER TABLE "Booking" ADD COLUMN "parentBookingId" TEXT;

CREATE INDEX "Booking_parentBookingId_idx" ON "Booking"("parentBookingId");

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_parentBookingId_fkey"
  FOREIGN KEY ("parentBookingId") REFERENCES "Booking"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
