import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  canManageFoodOrder,
  canViewFoodOrder,
} from "@/lib/food-order-access";
import {
  FOOD_ORDER_NOT_FOUND,
  foodOrderAuditContext,
  requireFoodOrderViewer,
} from "@/lib/food-order-route";
import { isValidFoodOrderPriceCents } from "@/lib/food-order-rules";
import { findFoodOrderForAction, setFoodOrderPrice } from "@/lib/food-orders";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * Record or change a food order's price (fork #121, owner decisions 8, 11, 12).
 *
 * The SAME rule as confirming receipt (`canManageFoodOrder`), and allowed on a
 * closed order too. The amount is integer cents, at least 0
 * (`isValidFoodOrderPriceCents`, INV-MONEY). It is a record only: nothing is
 * charged, invoiced, posted to the ledger or sent to Xero.
 *
 * Every change writes an audit row with who changed it and the old and new
 * amounts, in the same transaction as the change. The update is guarded on the
 * price this request read, so a concurrent edit answers 409 instead of being
 * recorded against the wrong old amount.
 */

const patchSchema = z.object({ priceCents: z.unknown() }).strict();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireFoodOrderViewer(() => requireActiveSession());
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success || !isValidFoodOrderPriceCents(parsed.data.priceCents)) {
    return NextResponse.json(
      { error: "Enter the price as an amount of zero or more." },
      { status: 400 },
    );
  }
  const priceCents = parsed.data.priceCents;

  const { id } = await params;
  const order = await findFoodOrderForAction(id);
  if (!order || !canViewFoodOrder(guard.viewer, order)) {
    return NextResponse.json(FOOD_ORDER_NOT_FOUND, { status: 404 });
  }
  if (!canManageFoodOrder(guard.viewer, order)) {
    return NextResponse.json(
      {
        error:
          "Only a committee member, a hut leader at this lodge, or a Lodge Operations admin can record this order's price.",
      },
      { status: 403 },
    );
  }

  const result = await setFoodOrderPrice(
    {
      orderId: order.id,
      actorId: guard.memberId,
      expectedCents: order.priceCents,
      priceCents,
    },
    foodOrderAuditContext(request),
  );
  if (result.outcome === "conflict") {
    return NextResponse.json(
      {
        error:
          "Somebody else changed this price just now. Reload to see it before changing it again.",
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ id: order.id, priceCents });
}
