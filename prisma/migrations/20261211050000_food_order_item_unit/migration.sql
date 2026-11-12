-- Fork #121 (owner change, 13 Nov 2026): each food-order line gets a unit
-- ("Type": Items, Grams, ... Milliliters, default Items), and its quantity
-- becomes a decimal (more than 0, at most 99999.99, two decimal places).
-- Earlier food-order migrations are applied on local databases and are not
-- edited. Every statement is safe to run twice.

-- CreateEnum (guarded: CREATE TYPE has no IF NOT EXISTS)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FoodOrderUnit') THEN
    CREATE TYPE "FoodOrderUnit" AS ENUM ('ITEMS', 'GRAMS', 'KILOGRAMS', 'LITERS', 'LOAVES', 'PACKETS', 'BOTTLES', 'BAGS', 'BOXES', 'PUNNETS', 'MILLILITERS');
  END IF;
END
$$;

-- Every existing line was counted in items.
ALTER TABLE "FoodOrderItem" ADD COLUMN IF NOT EXISTS "unit" "FoodOrderUnit" NOT NULL DEFAULT 'ITEMS';

-- integer -> numeric(7,2) is lossless for every value the old 1-999 CHECK allowed.
ALTER TABLE "FoodOrderItem" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(7,2);

-- Replace the whole-number range with the decimal one.
ALTER TABLE "FoodOrderItem" DROP CONSTRAINT IF EXISTS "FoodOrderItem_quantity_range";
ALTER TABLE "FoodOrderItem" DROP CONSTRAINT IF EXISTS "FoodOrderItem_quantity_positive";
ALTER TABLE "FoodOrderItem" ADD CONSTRAINT "FoodOrderItem_quantity_positive" CHECK ("quantity" > 0 AND "quantity" <= 99999.99);
