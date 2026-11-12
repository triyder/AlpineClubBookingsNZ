import type { DataMigrationVerification } from "./types";

/**
 * Fork #121 (owner change, 13 Nov 2026): food orders are received item by item.
 *
 * The backfill makes an order that was already closed as RECEIVED read as every
 * one of its items received, at the order's own moment and by the same person.
 * An OPEN order's items stay unreceived, and an item that already carries its
 * own mark keeps it.
 */

const RECEIVED_AT = "2026-11-12 09:30:00.000";
const EARLIER = "2026-11-10 08:00:00.000";

const SEED = `
  INSERT INTO "Lodge" ("id", "name", "slug", "updatedAt") VALUES
    ('dmv-121-lodge', 'Food Lodge', 'dmv-121-lodge', TIMESTAMP '2026-11-01 00:00:00');
  INSERT INTO "FoodOrder" ("id", "lodgeId", "memberId", "neededBy", "status", "receivedAt", "receivedById", "updatedAt") VALUES
    ('dmv-121-open', 'dmv-121-lodge', NULL, DATE '2026-11-20', 'OPEN', NULL, NULL, TIMESTAMP '2026-11-01 00:00:00'),
    ('dmv-121-closed', 'dmv-121-lodge', NULL, DATE '2026-11-12', 'RECEIVED', TIMESTAMP '${RECEIVED_AT}', 'officer-1', TIMESTAMP '2026-11-12 09:30:00');
  INSERT INTO "FoodOrderItem" ("id", "foodOrderId", "description", "quantity", "sortOrder") VALUES
    ('dmv-121-open-a', 'dmv-121-open', 'Bread', 2, 0),
    ('dmv-121-open-b', 'dmv-121-open', 'Milk', 1, 1),
    ('dmv-121-closed-a', 'dmv-121-closed', 'Flour', 3, 0),
    ('dmv-121-closed-b', 'dmv-121-closed', 'Eggs', 12, 1);
`;

const ITEMS_SQL = `
  SELECT "id",
         to_char("receivedAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "receivedAt",
         "receivedById"
  FROM "FoodOrderItem"
  WHERE "id" LIKE 'dmv-121-%'
  ORDER BY "id" COLLATE "C"
`;

const verification: DataMigrationVerification = {
  migration: "20261211040000_add_food_order_item_received",
  intent:
    "Add FoodOrderItem.receivedAt and receivedById, and stamp every item of an order already RECEIVED with that order's receivedAt and receivedById; leave OPEN orders' items unreceived and keep any item's existing mark.",
  idempotentReRun: true,
  cases: [
    {
      name: "a club with one open order and one order already closed as received",
      seed: SEED,
      expectations: [
        {
          claim:
            "the received order's items carry its moment and officer, and the open order's items are untouched",
          sql: ITEMS_SQL,
          rows: [
            { id: "dmv-121-closed-a", receivedAt: RECEIVED_AT, receivedById: "officer-1" },
            { id: "dmv-121-closed-b", receivedAt: RECEIVED_AT, receivedById: "officer-1" },
            { id: "dmv-121-open-a", receivedAt: null, receivedById: null },
            { id: "dmv-121-open-b", receivedAt: null, receivedById: null },
          ],
        },
      ],
    },
    {
      name: "a received order with one item that already carries its own mark",
      seed: `${SEED}
        UPDATE "FoodOrderItem"
        SET "receivedAt" = TIMESTAMP '${EARLIER}', "receivedById" = 'officer-0'
        WHERE "id" = 'dmv-121-closed-a';
      `,
      expectations: [
        {
          claim: "an existing item mark is kept, and only the unmarked item is stamped",
          sql: ITEMS_SQL,
          rows: [
            { id: "dmv-121-closed-a", receivedAt: EARLIER, receivedById: "officer-0" },
            { id: "dmv-121-closed-b", receivedAt: RECEIVED_AT, receivedById: "officer-1" },
            { id: "dmv-121-open-a", receivedAt: null, receivedById: null },
            { id: "dmv-121-open-b", receivedAt: null, receivedById: null },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "stamp the items of every order, open ones included",
      harm:
        "An open order's items read as received, so the officer's checklist shows food as arrived that never came and the order closes on the next tick.",
      find: `  AND o."status" = 'RECEIVED'
`,
      replace: ``,
    },
    {
      name: "overwrite an item's existing mark",
      harm:
        "An item ticked at its own moment is restamped with the order's time and officer, so the record of who received what, and when, is lost.",
      find: `  AND o."status" = 'RECEIVED'
  AND i."receivedAt" IS NULL;`,
      replace: `  AND o."status" = 'RECEIVED';`,
    },
    {
      name: "stamp a fixed time instead of the order's",
      harm: "Every backfilled item claims a received moment that never happened.",
      find: `SET "receivedAt" = o."receivedAt",`,
      replace: `SET "receivedAt" = TIMESTAMP '1970-01-01 00:00:00',`,
    },
  ],
};

export default verification;
