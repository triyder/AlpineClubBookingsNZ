-- #1098: backfill BookingGuestNight rows for pre-#713 guests so the #1036
-- nightly price lock covers legacy bookings. Guests created before the uniform
-- night-row model have no rows, so edits still repriced their whole stay at
-- current season rates (the documented #1054 fallback).
--
-- For each guest with no night rows on a live, non-quote-priced booking,
-- synthesise one row per night of the guest's stayStart..stayEnd envelope with
-- the guest's stored price split evenly across the nights (integer cents,
-- remainder on the first night — splitPriceAcrossGuests semantics). Quote-
-- priced bookings are skipped deliberately: the #1032 edit block already
-- protects their negotiated prices, and their per-guest flat splits are not
-- per-night rates.
--
-- Idempotent: only guests with zero existing rows are touched, and the unique
-- (bookingGuestId, stayDate) constraint plus ON CONFLICT DO NOTHING make a
-- replay a no-op.
INSERT INTO "BookingGuestNight" ("id", "bookingGuestId", "stayDate", "priceCents")
SELECT
  gen_random_uuid()::text,
  g."id",
  night.d::date,
  CASE
    WHEN night.d::date = g."stayStart"
      THEN (g."priceCents" / n.night_count)
           + (g."priceCents" - (g."priceCents" / n.night_count) * n.night_count)
    ELSE g."priceCents" / n.night_count
  END
FROM "BookingGuest" g
JOIN "Booking" b ON b."id" = g."bookingId"
CROSS JOIN LATERAL (
  SELECT (g."stayEnd" - g."stayStart")::int AS night_count
) n
CROSS JOIN LATERAL generate_series(
  g."stayStart"::timestamp,
  (g."stayEnd" - INTERVAL '1 day')::timestamp,
  INTERVAL '1 day'
) AS night(d)
WHERE n.night_count > 0
  AND b."deletedAt" IS NULL
  AND b."status" NOT IN ('CANCELLED', 'BUMPED')
  AND NOT EXISTS (
    SELECT 1
    FROM "BookingGuestNight" existing
    WHERE existing."bookingGuestId" = g."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "BookingRequest" r
    WHERE r."convertedBookingId" = b."id"
       OR r."heldBookingId" = b."id"
  )
ON CONFLICT ("bookingGuestId", "stayDate") DO NOTHING;
