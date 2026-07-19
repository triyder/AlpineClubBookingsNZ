"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface WaitlistOfferCardProps {
  bookingId: string;
  expiresAt: string;
  finalPriceCents: number;
  // Cross-lodge offer (ADR-004): the alternate lodge and the price quoted
  // for it. Both null for a same-lodge offer, which renders as before.
  offeredLodgeName?: string | null;
  offeredPriceCents?: number | null;
}

function formatOfferCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function WaitlistOfferCard({
  bookingId,
  expiresAt,
  finalPriceCents,
  offeredLodgeName,
  offeredPriceCents,
}: WaitlistOfferCardProps) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [timeLeft, setTimeLeft] = useState("");
  // Refreshed quote after an OFFER_PRICE_CHANGED rejection; the member
  // re-confirms at this figure.
  const [updatedPriceCents, setUpdatedPriceCents] = useState<number | null>(null);
  const isCrossLodge = offeredPriceCents !== null && offeredPriceCents !== undefined;
  const displayPriceCents = updatedPriceCents ?? offeredPriceCents;

  useEffect(() => {
    function updateCountdown() {
      const now = Date.now();
      const expires = new Date(expiresAt).getTime();
      const diff = expires - now;

      if (diff <= 0) {
        setTimeLeft("Expired");
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setTimeLeft(`${hours}h ${minutes}m remaining`);
    }

    updateCountdown();
    const interval = setInterval(updateCountdown, 60000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  async function handleConfirm() {
    setConfirming(true);
    setError("");

    const res = await fetch(`/api/bookings/${bookingId}/waitlist-confirm`, {
      method: "POST",
    });

    const data = await res.json();

    if (res.ok && data.success) {
      if (data.newBookingId) {
        // Cross-lodge accept: the entry was replaced by a fresh booking at the
        // offered lodge — hard-navigate there. A full load (not router.push)
        // keeps the F28 guarantee that the CTA can never stick on "Confirming…".
        window.location.href = `/bookings/${data.newBookingId}`;
        return;
      }
      // Hard reload: the confirm POST succeeded server-side, so re-render the
      // page from the server to its new status (CONFIRMED/PENDING/PAID) with a
      // full document reload. `confirming` stays true until the reload navigates,
      // so the CTA can never stick on "Confirming…". A soft router.refresh()
      // raced the server re-render and could leave the button frozen (#1371 F28).
      window.location.reload();
    } else {
      if (data.code === "OFFER_PRICE_CHANGED" && typeof data.updatedPriceCents === "number") {
        setUpdatedPriceCents(data.updatedPriceCents);
      }
      setError(data.error || "Failed to confirm booking");
      setConfirming(false);
    }
  }

  const isExpired = timeLeft === "Expired";

  return (
    <Card className="border-primary/30 bg-card">
      <CardHeader>
        <CardTitle className="text-foreground">A Spot Has Opened Up!</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isCrossLodge ? (
          <>
            <p className="text-sm text-muted-foreground">
              A spot has become available at{" "}
              <strong>{offeredLodgeName ?? "another of our lodges"}</strong>, one
              of the alternate lodges you said you&apos;d accept.
            </p>
            <p className="text-sm text-muted-foreground">
              The price at this lodge for your stay is{" "}
              <strong>{displayPriceCents !== null && displayPriceCents !== undefined ? formatOfferCents(displayPriceCents) : ""}</strong>
              , which differs from your original booking. Nothing is booked
              until you confirm this price — your original waitlist entry is
              replaced only once you do.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            A spot has become available for your waitlisted booking. Confirm now to secure your place.
          </p>
        )}

        <div className="flex items-center gap-2 text-sm font-medium text-primary">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
          {isExpired ? (
            <span className="text-red-600">This offer has expired</span>
          ) : (
            <span>{timeLeft}</span>
          )}
        </div>

        {(isCrossLodge ? (displayPriceCents ?? 0) > 0 : finalPriceCents > 0) && (
          <p className="text-sm text-muted-foreground">
            You will be prompted to complete payment after confirming.
          </p>
        )}

        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

        <div className="flex gap-3">
          <Button
            onClick={handleConfirm}
            disabled={confirming || isExpired}
          >
            {confirming
              ? "Confirming..."
              : isCrossLodge && displayPriceCents !== null && displayPriceCents !== undefined
                ? `Confirm at ${offeredLodgeName ?? "this lodge"} for ${formatOfferCents(displayPriceCents)}`
                : "Confirm Booking"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
