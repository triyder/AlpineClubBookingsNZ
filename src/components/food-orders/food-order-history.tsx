"use client";

import { useCallback, useEffect, useState } from "react";

import { useClubFormat } from "@/components/club-format-provider";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FOOD_ORDER_STATUSES,
  FOOD_ORDER_STATUS_LABELS,
} from "@/lib/food-order-rules";
import { formatCents } from "@/lib/utils";

import { FoodOrderRow, type FoodOrderHistoryItem } from "./food-order-row";

/**
 * The food-order history (fork #121): filters, the order count and price total
 * for the filter, a page of orders, and a pager. Whether the viewer sees every
 * order or only their own is the server's answer (`canViewAll`), never decided
 * here.
 */

type HistoryPayload = {
  canViewAll: boolean;
  orders: FoodOrderHistoryItem[];
  page: number;
  pageSize: number;
  orderCount: number;
  pricedCount: number;
  priceTotalCents: number;
  officerLabel: string;
  lodges: Array<{ id: string; name: string }>;
};

type Filters = { lodgeId: string; status: string; from: string; to: string };

const ALL = "all";
const EMPTY_FILTERS: Filters = { lodgeId: ALL, status: ALL, from: "", to: "" };

function queryFor(filters: Filters, page: number): string {
  const params = new URLSearchParams();
  if (filters.lodgeId !== ALL) params.set("lodgeId", filters.lodgeId);
  if (filters.status !== ALL) params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (page > 1) params.set("page", String(page));
  return params.toString();
}

export function FoodOrderHistory({ highlightOrderId }: { highlightOrderId: string | null }) {
  const format = useClubFormat();
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [payload, setPayload] = useState<HistoryPayload | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const query = queryFor(applied, page);
      const res = await fetch(`/api/food-orders/history${query ? `?${query}` : ""}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(
          typeof data.error === "string" ? data.error : "Could not load your food orders.",
        );
      }
      setPayload((await res.json()) as HistoryPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your food orders.");
    }
  }, [applied, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageCount = payload
    ? Math.max(1, Math.ceil(payload.orderCount / payload.pageSize))
    : 1;

  return (
    <div className="space-y-4">
      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setApplied(draft);
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="food-history-lodge">Lodge</Label>
          <Select
            value={draft.lodgeId}
            onValueChange={(lodgeId) => setDraft({ ...draft, lodgeId })}
          >
            <SelectTrigger id="food-history-lodge">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All lodges</SelectItem>
              {(payload?.lodges ?? []).map((lodge) => (
                <SelectItem key={lodge.id} value={lodge.id}>
                  {lodge.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="food-history-status">Status</Label>
          <Select
            value={draft.status}
            onValueChange={(status) => setDraft({ ...draft, status })}
          >
            <SelectTrigger id="food-history-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              {FOOD_ORDER_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {FOOD_ORDER_STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="food-history-from">Needed from</Label>
          <Input
            id="food-history-from"
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="food-history-to">Needed to</Label>
          <Input
            id="food-history-to"
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit">Apply</Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setApplied(EMPTY_FILTERS);
              setPage(1);
            }}
          >
            Clear
          </Button>
        </div>
      </form>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {payload ? (
        <>
          <Card>
            <CardContent className="flex flex-wrap gap-6 pt-6 text-sm" role="status">
              <span>
                <strong>{payload.orderCount}</strong>{" "}
                {payload.orderCount === 1 ? "order" : "orders"}
              </span>
              <span>
                Recorded prices:{" "}
                <strong>{formatCents(payload.priceTotalCents, format)}</strong>
                {payload.pricedCount < payload.orderCount
                  ? ` (${payload.pricedCount} of ${payload.orderCount} priced)`
                  : ""}
              </span>
            </CardContent>
          </Card>

          {payload.orders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No food orders match.</p>
          ) : (
            <div className="space-y-3">
              {payload.orders.map((order) => (
                <FoodOrderRow
                  key={order.id}
                  order={order}
                  showOrderedBy={payload.canViewAll}
                  highlighted={order.id === highlightOrderId}
                  onChanged={() => void load()}
                />
              ))}
            </div>
          )}

          {pageCount > 1 ? (
            <div className="flex items-center justify-between text-sm">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </Button>
              <span>
                Page {payload.page} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pageCount}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      ) : error ? null : (
        <p className="text-sm text-muted-foreground">Loading...</p>
      )}
    </div>
  );
}
