"use client";

import { useState } from "react";

import { useClubFormat } from "@/components/club-format-provider";
import { useClubTime } from "@/components/club-time-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { formatStayDate, requireInstant } from "@/lib/club-time";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";
import {
  FOOD_ORDER_PRICE_CENTS_MAX,
  FOOD_ORDER_STATUS_LABELS,
  type FoodOrderStatusValue,
} from "@/lib/food-order-rules";
import { parseDecimalDollarsToCents } from "@/lib/money-input";
import { formatCents, formatCentsPlain } from "@/lib/utils";

/**
 * One order in the food-order history (fork #121).
 *
 * The Received button and the price editor appear only when the server said
 * `canManage` for this row — the value `canManageFoodOrder` computed. This
 * component has no access rule of its own (INV-SSOT); the routes re-check.
 */

export type FoodOrderHistoryItem = {
  id: string;
  lodgeName: string;
  orderedBy: string | null;
  isOwn: boolean;
  neededBy: string;
  notes: string | null;
  status: FoodOrderStatusValue;
  items: Array<{ description: string; quantity: number }>;
  receivedAt: string | null;
  receivedBy: string | null;
  priceCents: number | null;
  priceUpdatedBy: string | null;
  canManage: boolean;
};

export function FoodOrderRow({
  order,
  showOrderedBy,
  highlighted,
  onChanged,
}: {
  order: FoodOrderHistoryItem;
  showOrderedBy: boolean;
  highlighted: boolean;
  onChanged: () => void;
}) {
  const format = useClubFormat();
  const club = useClubTime();
  const [priceDraft, setPriceDraft] = useState(
    order.priceCents === null ? "" : formatCentsPlain(order.priceCents),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function markReceived() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/food-orders/${encodeURIComponent(order.id)}/received`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await apiErrorMessageFromResponse(res, "Could not mark it received."));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark it received.");
    } finally {
      setBusy(false);
    }
  }

  async function savePrice() {
    const priceCents = parseDecimalDollarsToCents(priceDraft);
    if (priceCents === null || priceCents > FOOD_ORDER_PRICE_CENTS_MAX) {
      setError("Enter the price as an amount of zero or more, such as 42.50.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/food-orders/${encodeURIComponent(order.id)}/price`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceCents }),
      });
      if (!res.ok) throw new Error(await apiErrorMessageFromResponse(res, "Could not save the price."));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the price.");
    } finally {
      setBusy(false);
    }
  }

  const priceInputId = `food-order-price-${order.id}`;
  const parsedDraft = parseDecimalDollarsToCents(priceDraft);
  const priceDirty = parsedDraft !== order.priceCents;

  return (
    <Card id={`food-order-${order.id}`} className={highlighted ? "ring-2 ring-primary" : undefined}>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-medium">
              {order.lodgeName} — needed by {formatStayDate(order.neededBy, format)}
            </p>
            {showOrderedBy ? (
              <p className="text-sm text-muted-foreground">
                Ordered by {order.orderedBy ?? "a former member"}
                {order.isOwn ? " (you)" : ""}
              </p>
            ) : null}
          </div>
          <Badge variant={order.status === "RECEIVED" ? "success" : "warning"}>
            {FOOD_ORDER_STATUS_LABELS[order.status]}
          </Badge>
        </div>

        <ul className="list-inside list-disc text-sm">
          {order.items.map((item, index) => (
            <li key={index}>
              {item.quantity} × {item.description}
            </li>
          ))}
        </ul>
        {order.notes ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{order.notes}</p>
        ) : null}

        <div className="text-sm text-muted-foreground">
          {order.status === "RECEIVED" && order.receivedAt ? (
            <p>
              Received {club.instantDate(requireInstant(order.receivedAt))}
              {order.receivedBy ? `, confirmed by ${order.receivedBy}` : ""}
            </p>
          ) : null}
          <p>
            Price:{" "}
            {order.priceCents === null
              ? "not recorded"
              : formatCents(order.priceCents, format)}
            {order.priceCents !== null && order.priceUpdatedBy
              ? ` (recorded by ${order.priceUpdatedBy})`
              : ""}
          </p>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {order.canManage ? (
          <div className="flex flex-wrap items-end gap-3 border-t pt-3">
            {order.status === "OPEN" ? (
              <Button size="sm" onClick={() => void markReceived()} disabled={busy}>
                Mark received
              </Button>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor={priceInputId}>Price</Label>
              <MoneyInput
                id={priceInputId}
                className="w-32"
                value={priceDraft}
                onValueChange={setPriceDraft}
                minCents={0}
                maxCents={FOOD_ORDER_PRICE_CENTS_MAX}
                disabled={busy}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void savePrice()}
              disabled={busy || !priceDirty || priceDraft.trim() === ""}
            >
              Save price
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
