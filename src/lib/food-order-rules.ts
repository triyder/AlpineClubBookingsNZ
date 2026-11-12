/**
 * The food-order limits and pure rules (fork #121).
 *
 * A CLIENT-SAFE MODULE ON PURPOSE, like `maintenance-report-limits.ts`: the
 * order form, the history page and the settings card import these in the
 * browser, and the server routes import the SAME numbers, so the UI can never
 * offer something the server refuses (INV-SSOT). No Prisma, no `server-only`,
 * no club-time server reader.
 */
import { MAX_INTEGER_CENTS } from "@/lib/money-input";

/** An order holds 1 to 50 item lines (owner decision 13, issue item 6). */
export const FOOD_ORDER_MIN_ITEMS = 1;
export const FOOD_ORDER_MAX_ITEMS = 50;

/** Each line's description: required, up to 200 characters. */
export const FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH = 200;

/**
 * Each line's quantity: a whole number from 1 to 999. Units go in the
 * description ("1 kg bags of flour"), which keeps quantities easy to total.
 */
export const FOOD_ORDER_ITEM_QUANTITY_MIN = 1;
export const FOOD_ORDER_ITEM_QUANTITY_MAX = 999;

/** The optional note on an order. Matches the `FoodOrder.notes` column. */
export const FOOD_ORDER_NOTES_MAX_LENGTH = 1000;

/** The officer label (INV-CONFIG-001) and its default. */
export const DEFAULT_FOOD_OFFICER_LABEL = "Food officer";
export const FOOD_OFFICER_LABEL_MAX_LENGTH = 60;

/** The officer email column's width (RFC 5321's practical maximum). */
export const FOOD_OFFICER_EMAIL_MAX_LENGTH = 254;

/**
 * The largest price a person may record: the integer-cents ceiling every money
 * column shares (INV-MONEY-001). The price is a record only and moves no money.
 */
export const FOOD_ORDER_PRICE_CENTS_MAX = MAX_INTEGER_CENTS;

/** How many orders one history page shows. */
export const FOOD_ORDER_HISTORY_PAGE_SIZE = 25;

export const FOOD_ORDER_STATUSES = ["OPEN", "RECEIVED"] as const;
export type FoodOrderStatusValue = (typeof FOOD_ORDER_STATUSES)[number];

export const FOOD_ORDER_STATUS_LABELS: Record<FoodOrderStatusValue, string> = {
  OPEN: "Open",
  RECEIVED: "Received",
};

export type FoodOrderItemInput = { description: string; quantity: number };

/**
 * Why a set of item lines would be refused, or null when it is acceptable.
 * The one rule the form and the create route both apply.
 */
export function foodOrderItemsProblem(
  items: readonly FoodOrderItemInput[],
): string | null {
  if (items.length < FOOD_ORDER_MIN_ITEMS) {
    return "Add at least one item to the order.";
  }
  if (items.length > FOOD_ORDER_MAX_ITEMS) {
    return `An order can hold up to ${FOOD_ORDER_MAX_ITEMS} items.`;
  }
  for (const item of items) {
    const description = item.description.trim();
    if (description.length === 0) {
      return "Every item needs a description.";
    }
    if (description.length > FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH) {
      return `Keep each description to ${FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH} characters.`;
    }
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < FOOD_ORDER_ITEM_QUANTITY_MIN ||
      item.quantity > FOOD_ORDER_ITEM_QUANTITY_MAX
    ) {
      return `Each quantity must be a whole number from ${FOOD_ORDER_ITEM_QUANTITY_MIN} to ${FOOD_ORDER_ITEM_QUANTITY_MAX}.`;
    }
  }
  return null;
}

/** Whether a recorded price is acceptable: integer cents, 0 to the ceiling. */
export function isValidFoodOrderPriceCents(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= FOOD_ORDER_PRICE_CENTS_MAX
  );
}
