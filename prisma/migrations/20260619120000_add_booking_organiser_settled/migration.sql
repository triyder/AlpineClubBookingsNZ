-- Group booking ORGANISER_PAYS mode: flag child bookings the organiser settles
-- as part of one combined bill. The joiner is never billed for these and cannot
-- pay them directly; the organiser-settlement flow collects the group total and
-- marks them PAID. Defaults false, so every existing (each-pays) booking is
-- unchanged.
ALTER TABLE "Booking" ADD COLUMN "organiserSettled" BOOLEAN NOT NULL DEFAULT false;
