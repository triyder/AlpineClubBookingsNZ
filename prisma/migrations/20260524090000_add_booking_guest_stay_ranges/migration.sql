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

-- Blue/green compatibility: app containers from the previous release do not
-- send stayStart/stayEnd when inserting BookingGuest rows. Keep those writes
-- valid during the deployment window by deriving the range from the parent
-- booking before the NOT NULL constraint is checked.
CREATE OR REPLACE FUNCTION "set_booking_guest_stay_range_defaults"()
RETURNS trigger AS $$
BEGIN
  IF NEW."stayStart" IS NULL OR NEW."stayEnd" IS NULL THEN
    SELECT
      COALESCE(NEW."stayStart", b."checkIn"::date),
      COALESCE(NEW."stayEnd", b."checkOut"::date)
    INTO NEW."stayStart", NEW."stayEnd"
    FROM "Booking" AS b
    WHERE b."id" = NEW."bookingId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BookingGuest_set_stay_range_defaults"
BEFORE INSERT OR UPDATE OF "bookingId", "stayStart", "stayEnd"
ON "BookingGuest"
FOR EACH ROW
WHEN (NEW."stayStart" IS NULL OR NEW."stayEnd" IS NULL)
EXECUTE FUNCTION "set_booking_guest_stay_range_defaults"();

ALTER TABLE "BookingGuest"
  ALTER COLUMN "stayStart" SET NOT NULL,
  ALTER COLUMN "stayEnd" SET NOT NULL;

CREATE INDEX "BookingGuest_bookingId_stayStart_stayEnd_idx"
  ON "BookingGuest"("bookingId", "stayStart", "stayEnd");

CREATE INDEX "BookingGuest_stayStart_stayEnd_idx"
  ON "BookingGuest"("stayStart", "stayEnd");
