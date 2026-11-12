import { NextRequest, NextResponse } from "next/server";

import { dateOnlyInstantOf, parseCalendarDate } from "@/lib/club-time";
import { requireFoodOrderViewer } from "@/lib/food-order-route";
import { FOOD_ORDER_STATUSES } from "@/lib/food-order-rules";
import { loadFoodOrderSettings } from "@/lib/food-order-settings";
import {
  listFoodOrderHistory,
  type FoodOrderHistoryFilters,
} from "@/lib/food-orders";
import { prisma } from "@/lib/prisma";

/**
 * The food-order history (fork #121). A member gets their own orders; a viewer
 * `canViewAllFoodOrders` admits (committee, a current hut leader, Lodge
 * Operations view) gets every order. Both can filter by lodge, status and a
 * needed-by date range, paged, with the order count and price total for the
 * whole filter. Each row carries `canManage` from `canManageFoodOrder`, which is
 * the only thing the page uses to show the Received and price controls.
 *
 * A malformed filter value is refused rather than ignored, so a typo never
 * silently widens the totals a club is forecasting from.
 */

function parseFilters(
  params: URLSearchParams,
): FoodOrderHistoryFilters | { error: string } {
  const filters: FoodOrderHistoryFilters = { page: 1 };

  const lodgeId = params.get("lodgeId")?.trim();
  if (lodgeId) {
    if (lodgeId.length > 64) return { error: "Unknown lodge filter." };
    filters.lodgeId = lodgeId;
  }

  const status = params.get("status")?.trim();
  if (status) {
    const match = FOOD_ORDER_STATUSES.find((value) => value === status);
    if (!match) return { error: "Unknown status filter." };
    filters.status = match;
  }

  for (const [key, field] of [
    ["from", "neededFrom"],
    ["to", "neededTo"],
  ] as const) {
    const raw = params.get(key)?.trim();
    if (!raw) continue;
    const date = parseCalendarDate(raw);
    if (!date) return { error: "Dates must be in YYYY-MM-DD form." };
    filters[field] = dateOnlyInstantOf(date);
  }

  const page = params.get("page");
  if (page) {
    const value = Number(page);
    if (!Number.isInteger(value) || value < 1 || value > 100_000) {
      return { error: "Unknown page." };
    }
    filters.page = value;
  }
  return filters;
}

export async function GET(request: NextRequest) {
  const guard = await requireFoodOrderViewer();
  if (!guard.ok) return guard.response;

  const filters = parseFilters(request.nextUrl.searchParams);
  if ("error" in filters) {
    return NextResponse.json({ error: filters.error }, { status: 400 });
  }

  const [history, settings, lodges] = await Promise.all([
    listFoodOrderHistory(guard.viewer, filters),
    loadFoodOrderSettings(),
    prisma.lodge.findMany({
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  return NextResponse.json({
    ...history,
    officerLabel: settings.officerLabel,
    lodges,
  });
}
