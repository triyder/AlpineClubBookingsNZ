-- Dedupe member join rows before adding the unique pair (#1039 item 2):
-- keep, per (groupBookingId, joinerMemberId), the row whose booking is live
-- (not deleted/cancelled/bumped), falling back to the newest row.
WITH ranked AS (
  SELECT j.id,
         ROW_NUMBER() OVER (
           PARTITION BY j."groupBookingId", j."joinerMemberId"
           ORDER BY (
             b.id IS NOT NULL
             AND b."deletedAt" IS NULL
             AND b.status NOT IN ('CANCELLED', 'BUMPED')
           ) DESC,
           j."createdAt" DESC
         ) AS rn
  FROM "GroupBookingJoin" j
  LEFT JOIN "Booking" b ON b.id = j."bookingId"
  WHERE j."joinerMemberId" IS NOT NULL
)
DELETE FROM "GroupBookingJoin"
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- CreateIndex
CREATE UNIQUE INDEX "GroupBookingJoin_groupBookingId_joinerMemberId_key" ON "GroupBookingJoin"("groupBookingId", "joinerMemberId");
