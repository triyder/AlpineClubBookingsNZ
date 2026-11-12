-- Fork #121 (owner change, 13 Nov 2026): food orders are received item by item.
-- Expand-only: two nullable columns on FoodOrderItem, which the previously
-- deployed release never names, and a backfill so an order already closed as
-- RECEIVED reads as every one of its items received, at the order's own moment
-- and by the same person.

-- AlterTable
ALTER TABLE "FoodOrderItem" ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "receivedById" TEXT;

-- Backfill: only items of RECEIVED orders that have no item-level mark yet.
UPDATE "FoodOrderItem" i
SET "receivedAt" = o."receivedAt",
    "receivedById" = o."receivedById"
FROM "FoodOrder" o
WHERE i."foodOrderId" = o."id"
  AND o."status" = 'RECEIVED'
  AND i."receivedAt" IS NULL;
