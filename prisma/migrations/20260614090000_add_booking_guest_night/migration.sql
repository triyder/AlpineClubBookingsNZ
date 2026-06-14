-- Per-guest per-night stay records (issue #713 — multi date range stays).
--
-- A booking guest may stay non-contiguous nights within one booking. Each
-- included night becomes one BookingGuestNight row carrying that night's price
-- in integer cents. The guest's stayStart/stayEnd remain the derived min/max
-- envelope, kept in sync on every write, so read surfaces (kiosk, reports,
-- rosters) keep working off the envelope unchanged.

CREATE TABLE "BookingGuestNight" (
    "id" TEXT NOT NULL,
    "bookingGuestId" TEXT NOT NULL,
    "stayDate" DATE NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingGuestNight_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingGuestNight_bookingGuestId_stayDate_key"
ON "BookingGuestNight"("bookingGuestId", "stayDate");

CREATE INDEX "BookingGuestNight_stayDate_idx"
ON "BookingGuestNight"("stayDate");

ALTER TABLE "BookingGuestNight"
ADD CONSTRAINT "BookingGuestNight_bookingGuestId_fkey"
FOREIGN KEY ("bookingGuestId") REFERENCES "BookingGuest"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill every existing guest as a full contiguous range: one row per night
-- from stayStart (inclusive) to stayEnd (exclusive). Done in SQL because the
-- bookings table may be large. The stored guest total (BookingGuest.priceCents)
-- is split evenly across the nights, with any integer-cent remainder allocated
-- to the earliest nights, so SUM(BookingGuestNight.priceCents) per guest equals
-- BookingGuest.priceCents exactly (no financial drift on existing bookings).
INSERT INTO "BookingGuestNight" ("id", "bookingGuestId", "stayDate", "priceCents", "createdAt")
SELECT
    'bgn_' || md5(g."id" || ':' || to_char(n."stayDate", 'YYYY-MM-DD')),
    g."id",
    n."stayDate",
    (g."priceCents" / nc."nightCount")
        + (CASE WHEN n."idx" < (g."priceCents" % nc."nightCount") THEN 1 ELSE 0 END),
    CURRENT_TIMESTAMP
FROM "BookingGuest" g
CROSS JOIN LATERAL (
    SELECT GREATEST((g."stayEnd"::date - g."stayStart"::date), 1) AS "nightCount"
) nc
CROSS JOIN LATERAL (
    SELECT
        d::date AS "stayDate",
        (ROW_NUMBER() OVER (ORDER BY d) - 1)::int AS "idx"
    FROM generate_series(
        g."stayStart"::date,
        (g."stayEnd"::date - 1),
        INTERVAL '1 day'
    ) AS d
) n;
