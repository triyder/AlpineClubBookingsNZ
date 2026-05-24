-- Add per-guest stay ranges so future booking edits can preserve historical
-- occupancy while changing only unused future nights.
ALTER TABLE "BookingGuest"
  ADD COLUMN "stayStart" DATE,
  ADD COLUMN "stayEnd" DATE;

UPDATE "BookingGuest" AS bg
SET
  "stayStart" = b."checkIn"::date,
  "stayEnd" = b."checkOut"::date
FROM "Booking" AS b
WHERE bg."bookingId" = b."id";

ALTER TABLE "BookingGuest"
  ALTER COLUMN "stayStart" SET NOT NULL,
  ALTER COLUMN "stayEnd" SET NOT NULL;

CREATE INDEX "BookingGuest_bookingId_stayStart_stayEnd_idx"
  ON "BookingGuest"("bookingId", "stayStart", "stayEnd");

CREATE INDEX "BookingGuest_stayStart_stayEnd_idx"
  ON "BookingGuest"("stayStart", "stayEnd");
