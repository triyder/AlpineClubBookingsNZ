"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/confirm-dialog";
import { formatCents } from "@/lib/utils";

interface ConfirmPendingGuestsButtonProps {
  bookingId: string;
  hasSavedPaymentMethod: boolean;
  finalPriceCents: number;
}

export function ConfirmPendingGuestsButton({
  bookingId,
  hasSavedPaymentMethod,
  finalPriceCents,
}: ConfirmPendingGuestsButtonProps) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  // Mirror the server's branch order: a zero-dollar booking is confirmed at no
  // charge regardless of a card on file; otherwise a saved card is charged, and
  // without one the booking moves to payment-owed.
  const isZeroDollar = finalPriceCents === 0;
  const willCharge = !isZeroDollar && hasSavedPaymentMethod;
  const consequence = isZeroDollar
    ? "This will confirm the booking at no charge."
    : hasSavedPaymentMethod
      ? `The member's saved card will be charged ${formatCents(finalPriceCents)}.`
      : "This will move the booking to payment-owed (no card on file).";

  async function handleConfirm() {
    const confirmed = await confirm({
      title: "Confirm pending guests?",
      description: `${consequence} This locks the non-member guests in and clears the hold so the booking won't be bumped.`,
      confirmLabel: willCharge ? "Charge and confirm" : "Confirm",
    });
    if (!confirmed) return;

    setConfirming(true);
    setError("");

    try {
      const res = await fetch(
        `/api/admin/bookings/${bookingId}/confirm-pending-guests`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );

      if (res.ok) {
        toast.success("Pending guests confirmed.");
        router.refresh();
        return;
      }

      const data = await res.json().catch(() => ({}));
      const message =
        data.error === "CAPACITY_EXCEEDED"
          ? "Not enough beds remain for these dates. Use Force confirm to overbook if intended."
          : data.error || "Failed to confirm pending guests";
      setError(message);
      toast.error(message);
      setConfirming(false);
    } catch {
      const message = "Failed to confirm pending guests";
      setError(message);
      toast.error(message);
      setConfirming(false);
    }
  }

  return (
    <Card>
      {confirmDialog}
      <CardHeader>
        <CardTitle>Confirm pending guests now</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-600">
          This booking still has non-member guests on hold. Confirming now locks
          the guests in and clears the hold so the booking won&apos;t be bumped.
          {isZeroDollar
            ? " There is no charge for this booking."
            : hasSavedPaymentMethod
              ? ` The member's saved card will be charged ${formatCents(finalPriceCents)}.`
              : " There is no saved card, so the booking will move to payment-owed for payment to be arranged separately."}
        </p>
        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <Button onClick={handleConfirm} disabled={confirming}>
          {confirming ? "Confirming..." : "Confirm pending guests"}
        </Button>
      </CardContent>
    </Card>
  );
}
