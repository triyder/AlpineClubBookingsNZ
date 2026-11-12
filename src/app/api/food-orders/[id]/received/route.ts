import { NextRequest, NextResponse } from "next/server";

import {
  canManageFoodOrder,
  canViewFoodOrder,
} from "@/lib/food-order-access";
import {
  FOOD_ORDER_NOT_FOUND,
  foodOrderAuditContext,
  requireFoodOrderViewer,
} from "@/lib/food-order-route";
import { findFoodOrderForAction, markFoodOrderReceived } from "@/lib/food-orders";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * Mark a food order Received, which closes it (fork #121, owner decision 7).
 *
 * Who: `canManageFoodOrder` — committee, a hut leader at THIS order's lodge
 * today, or Lodge Operations edit. An order the caller may not even see answers
 * 404, so the route is not an oracle for other members' order ids; one they can
 * see but not manage answers 403.
 *
 * The close is a status-guarded claim (`OPEN` -> `RECEIVED`) inside
 * `markFoodOrderReceived`: two confirmations at once close it once, and the
 * second gets a 409 and changes nothing.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireFoodOrderViewer(() => requireActiveSession());
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const order = await findFoodOrderForAction(id);
  if (!order || !canViewFoodOrder(guard.viewer, order)) {
    return NextResponse.json(FOOD_ORDER_NOT_FOUND, { status: 404 });
  }
  if (!canManageFoodOrder(guard.viewer, order)) {
    return NextResponse.json(
      {
        error:
          "Only a committee member, a hut leader at this lodge, or a Lodge Operations admin can mark this order received.",
      },
      { status: 403 },
    );
  }

  const outcome = await markFoodOrderReceived(
    order.id,
    guard.memberId,
    foodOrderAuditContext(request),
  );
  if (outcome === "already_received") {
    return NextResponse.json(
      { error: "This order has already been marked received." },
      { status: 409 },
    );
  }
  return NextResponse.json({ id: order.id, status: "RECEIVED" });
}
