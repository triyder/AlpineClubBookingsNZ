import type { DataMigrationVerification } from "./types";

/**
 * Fork #121 (owner change, 13 Nov 2026): each food-order line gets a unit, and
 * its quantity becomes a decimal.
 *
 * The rewrite is the `integer -> numeric(7,2)` cast: every existing whole-number
 * quantity must keep its value exactly, every existing line must read as counted
 * in Items, and the new range (more than 0, up to 99999.99, two places) must
 * replace the old 1-999 whole-number one, so a half packet can be stored.
 */

const SEED = `
  INSERT INTO "Lodge" ("id", "name", "slug", "updatedAt") VALUES
    ('dmv-121u-lodge', 'Unit Lodge', 'dmv-121u-lodge', TIMESTAMP '2026-11-01 00:00:00');
  INSERT INTO "FoodOrder" ("id", "lodgeId", "neededBy", "updatedAt") VALUES
    ('dmv-121u-order', 'dmv-121u-lodge', DATE '2026-11-20', TIMESTAMP '2026-11-01 00:00:00');
  INSERT INTO "FoodOrderItem" ("id", "foodOrderId", "description", "quantity", "sortOrder") VALUES
    ('dmv-121u-a', 'dmv-121u-order', 'Bread', 1, 0),
    ('dmv-121u-b', 'dmv-121u-order', 'Eggs', 999, 1),
    ('dmv-121u-c', 'dmv-121u-order', 'Milk', 12, 2);
`;

/** Lines the old whole-number CHECK would refuse and the new range allows. */
const AFTER = `
  INSERT INTO "FoodOrderItem" ("id", "foodOrderId", "description", "quantity", "unit", "sortOrder") VALUES
    ('dmv-121u-half', 'dmv-121u-order', 'Rice', 0.5, 'PACKETS', 3),
    ('dmv-121u-grams', 'dmv-121u-order', 'Flour', 12345.67, 'GRAMS', 4);
`;

const ITEMS_SQL = `
  SELECT "id", "quantity"::text AS "quantity", "unit"::text AS "unit"
  FROM "FoodOrderItem"
  WHERE "id" LIKE 'dmv-121u-%'
  ORDER BY "id" COLLATE "C"
`;

const verification: DataMigrationVerification = {
  migration: "20261211050000_food_order_item_unit",
  intent:
    "Add FoodOrderItem.unit (default ITEMS for every existing line) and recast quantity from integer to numeric(7,2) without changing any stored value, replacing the 1-999 whole-number CHECK with quantity > 0 AND quantity <= 99999.99.",
  idempotentReRun: true,
  cases: [
    {
      name: "a club with an open food order of three whole-number lines",
      seed: SEED,
      afterMigration: AFTER,
      expectations: [
        {
          claim:
            "existing quantities keep their exact value as two-place decimals and read as Items; a half packet and 12345.67 grams can now be stored",
          sql: ITEMS_SQL,
          rows: [
            { id: "dmv-121u-a", quantity: "1.00", unit: "ITEMS" },
            { id: "dmv-121u-b", quantity: "999.00", unit: "ITEMS" },
            { id: "dmv-121u-c", quantity: "12.00", unit: "ITEMS" },
            { id: "dmv-121u-grams", quantity: "12345.67", unit: "GRAMS" },
            { id: "dmv-121u-half", quantity: "0.50", unit: "PACKETS" },
          ],
        },
        {
          claim:
            "the old whole-number range is gone and the decimal range is the item table's only CHECK",
          sql: `
            SELECT "conname" AS "name"
            FROM pg_constraint
            WHERE conrelid = '"FoodOrderItem"'::regclass AND contype = 'c'
            ORDER BY "conname" COLLATE "C"
          `,
          rows: [
            { name: "FoodOrderItem_quantity_positive" },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "recast to whole numbers instead of two decimal places",
      harm:
        "Half packets and 12345.67 grams round to whole numbers, so orders say something different from what the member typed.",
      find: `SET DATA TYPE DECIMAL(7,2);`,
      replace: `SET DATA TYPE DECIMAL(7,0);`,
    },
    {
      name: "default existing lines to another unit",
      harm: "Every order already placed suddenly reads as packets, not items.",
      find: `"unit" "FoodOrderUnit" NOT NULL DEFAULT 'ITEMS';`,
      replace: `"unit" "FoodOrderUnit" NOT NULL DEFAULT 'PACKETS';`,
    },
    {
      name: "keep the old whole-number range",
      harm: "A member can type 0.5 or 2500 grams and the order is refused by the database.",
      find: `ALTER TABLE "FoodOrderItem" DROP CONSTRAINT IF EXISTS "FoodOrderItem_quantity_range";
`,
      replace: ``,
    },
  ],
};

export default verification;
