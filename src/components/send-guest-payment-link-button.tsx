"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Split-booking guest-portion affordance (#1967). Shown with the
 * switch-to-Internet-Banking control (pre-switch) and on the booking page
 * after the member's own place is settled by internet banking: because paying
 * the member's own place by internet banking leaves no card on file for the
 * later guest charge, this lets the booker email themselves a secure payment
 * link for the guest portion. It posts to
 * /api/bookings/[id]/send-guest-payment-link, a true send/RE-SEND: an existing
 * link is revoked and a fresh one sent (raw tokens are never stored, so a new
 * mint is the only way to re-send), while a link minted within the last minute
 * short-circuits server-side — pressing the button twice never fans out
 * duplicate emails or leaves two live links.
 */
export function SendGuestPaymentLinkButton({ bookingId }: { bookingId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [sentOnce, setSentOnce] = useState(false);

  async function sendLink() {
    setBusy(true);
    setError("");
    setDone(null);
    try {
      const res = await fetch(
        `/api/bookings/${bookingId}/send-guest-payment-link`,
        { method: "POST", headers: { "content-type": "application/json" } }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data.error || "Unable to send the payment link right now."
        );
      }
      if (data.sent > 0) {
        setSentOnce(true);
        setDone(
          "We've emailed you a secure link to pay for your guests. Any earlier link no longer works."
        );
      } else if (data.justSent > 0) {
        setSentOnce(true);
        setDone(
          "A payment link was sent moments ago — check your email (and spam folder). You can request a fresh one in a minute."
        );
      } else {
        setDone("Your guests' payment is already taken care of.");
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to send the payment link right now."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <Button type="button" variant="outline" onClick={sendLink} disabled={busy}>
        {busy
          ? "Sending..."
          : sentOnce
            ? "Re-send the payment link"
            : "Email me a payment link for my guests"}
      </Button>
      {done ? (
        <p className="mt-2 text-sm text-emerald-700">{done}</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-sm text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
