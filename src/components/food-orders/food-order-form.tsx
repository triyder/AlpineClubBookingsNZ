"use client";

import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH,
  FOOD_ORDER_ITEM_QUANTITY_MAX,
  FOOD_ORDER_ITEM_QUANTITY_MIN,
  FOOD_ORDER_MAX_ITEMS,
  FOOD_ORDER_NOTES_MAX_LENGTH,
  foodOrderItemsProblem,
} from "@/lib/food-order-rules";

/**
 * The Order food form (fork #121). One line per item, each a description and a
 * whole-number quantity, with Add item and Remove; at least one line.
 *
 * The limits and the item rule are imported from `food-order-rules`, the same
 * module the create route validates with, so the form cannot accept something
 * the server refuses. The server is still the authority: its message is shown
 * as it is.
 */

export type FoodOrderFormSubmission = {
  lodgeId: string;
  neededBy: string;
  notes: string;
  items: Array<{ description: string; quantity: number }>;
};

type Line = { key: number; description: string; quantity: string };

export function FoodOrderForm({
  lodges,
  today,
  officerLabel,
  onSubmit,
}: {
  lodges: Array<{ id: string; name: string }>;
  /** The club's today, YYYY-MM-DD: the earliest needed-by date. */
  today: string;
  officerLabel: string;
  onSubmit: (submission: FoodOrderFormSubmission) => Promise<void>;
}) {
  const [lodgeId, setLodgeId] = useState(lodges.length === 1 ? (lodges[0]?.id ?? "") : "");
  const [neededBy, setNeededBy] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([
    { key: 0, description: "", quantity: "1" },
  ]);
  const [nextKey, setNextKey] = useState(1);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  function addLine() {
    if (lines.length >= FOOD_ORDER_MAX_ITEMS) return;
    setLines((current) => [
      ...current,
      { key: nextKey, description: "", quantity: "1" },
    ]);
    setNextKey((key) => key + 1);
  }

  function removeLine(key: number) {
    setLines((current) => current.filter((line) => line.key !== key));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const items = lines.map((line) => ({
      description: line.description.trim(),
      quantity: /^\d+$/.test(line.quantity.trim())
        ? Number(line.quantity.trim())
        : Number.NaN,
    }));
    if (!lodgeId) {
      setError("Choose the lodge the food is for.");
      return;
    }
    if (!neededBy || neededBy < today) {
      setError("Choose the date the food is needed by: today or later.");
      return;
    }
    const problem = foodOrderItemsProblem(items);
    if (problem) {
      setError(problem);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ lodgeId, neededBy, notes: notes.trim(), items });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong placing that order. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-6" onSubmit={(event) => void handleSubmit(event)} noValidate>
      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className="space-y-2">
        <Label htmlFor="food-order-lodge">Lodge</Label>
        <Select value={lodgeId} onValueChange={setLodgeId}>
          <SelectTrigger id="food-order-lodge" className="h-11">
            <SelectValue placeholder="Choose a lodge" />
          </SelectTrigger>
          <SelectContent>
            {lodges.map((lodge) => (
              <SelectItem key={lodge.id} value={lodge.id}>
                {lodge.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="food-order-needed-by">Needed by</Label>
        <Input
          id="food-order-needed-by"
          type="date"
          className="h-11 max-w-[12rem]"
          min={today}
          value={neededBy}
          onChange={(event) => setNeededBy(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          The {officerLabel.toLowerCase()} matches your order to your stay by the
          lodge and this date.
        </p>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Items</legend>
        <p className="text-xs text-muted-foreground">
          One line per item. Put the unit in the description, for example
          &quot;1 kg bags of flour&quot;, and a whole number from{" "}
          {FOOD_ORDER_ITEM_QUANTITY_MIN} to {FOOD_ORDER_ITEM_QUANTITY_MAX} as the
          quantity.
        </p>
        {lines.map((line, index) => (
          <div key={line.key} className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor={`food-item-description-${line.key}`}>
                Item {index + 1}
              </Label>
              <Input
                id={`food-item-description-${line.key}`}
                className="h-11"
                maxLength={FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH}
                value={line.description}
                onChange={(event) =>
                  updateLine(line.key, { description: event.target.value })
                }
              />
            </div>
            <div className="w-20 space-y-1">
              <Label htmlFor={`food-item-quantity-${line.key}`}>Quantity</Label>
              <Input
                id={`food-item-quantity-${line.key}`}
                className="h-11"
                inputMode="numeric"
                value={line.quantity}
                onChange={(event) =>
                  updateLine(line.key, { quantity: event.target.value })
                }
              />
            </div>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => removeLine(line.key)}
              disabled={lines.length <= 1}
              aria-label={`Remove item ${index + 1}`}
            >
              <X className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only sm:ml-1">Remove</span>
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={addLine}
          disabled={lines.length >= FOOD_ORDER_MAX_ITEMS}
        >
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Add item
        </Button>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="food-order-notes">Note (optional)</Label>
        <Textarea
          id="food-order-notes"
          rows={3}
          maxLength={FOOD_ORDER_NOTES_MAX_LENGTH}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>

      <Button type="submit" className="h-11 w-full" disabled={submitting}>
        {submitting ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
        ) : null}
        Send this order
      </Button>
    </form>
  );
}
