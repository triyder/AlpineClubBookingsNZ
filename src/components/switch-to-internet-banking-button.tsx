"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * Lets the owner of a card (Stripe) PAYMENT_PENDING booking switch to Internet
 * Banking instead. Posts to /api/payments/switch-to-internet-banking, then
 * refreshes so the page re-renders with the emailed-invoice reference (the detail
 * page already shows the Internet Banking card for an IB booking). Only rendered
 * when the Internet Banking module is on.
 */
export function SwitchToInternetBankingButton({
  bookingId,
  description = "Prefer to pay by bank transfer? We'll email you a Xero invoice.",
}: {
  bookingId: string;
  description?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function switchToInternetBanking() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/payments/switch-to-internet-banking", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to switch to internet banking right now.");
      }
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to switch to internet banking right now."
      );
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t pt-4">
      <p className="mb-2 text-sm text-muted-foreground">
        {description}
      </p>
      <Button variant="outline" onClick={switchToInternetBanking} disabled={busy}>
        {busy ? "Switching..." : "Pay by internet banking instead"}
      </Button>
      {error ? (
        <p className="mt-2 text-sm text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
