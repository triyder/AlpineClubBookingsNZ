"use client";

import { useEffect, useEffectEvent, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { type BookingPaymentMode } from "@/lib/booking-payment-flow";
import StripeProvider from "./StripeProvider";
import PaymentForm from "./PaymentForm";
import SetupForm from "./SetupForm";

/**
 * Report a payment-initialization failure to ops WITHOUT ever surfacing the raw
 * provider detail to the member (#1223). The raw detail (from the API response
 * or a thrown error) can contain partial key material such as
 * "Invalid API Key provided: sk_test_***", so it must never be rendered AND must
 * not reach the member's browser console — it is sent only to Sentry, whose
 * `beforeSend` scrubs `sk_*`/secret material before ingestion. The UI shows only
 * generic, member-safe copy. The client-side console log is intentionally
 * detail-free (bookingId only) so no key fragment lands in a member's DevTools.
 */
function reportPaymentInitError(bookingId: string, detail: unknown) {
  Sentry.captureException(
    detail instanceof Error
      ? detail
      : new Error(
          typeof detail === "string" ? detail : "Payment initialization failed"
        ),
    { tags: { area: "booking-payment-init" }, extra: { bookingId, detail } }
  );
  console.error("Booking payment initialization failed", { bookingId });
}

interface BookingPaymentWrapperProps {
  bookingId: string;
  amountCents: number;
  paymentMode: BookingPaymentMode;
  returnUrl: string;
  onPaymentComplete: () => void;
}

/**
 * Renders the Stripe flow for a persisted booking state.
 * Booking status is the source of truth for whether this page should charge now
 * or only save a payment method for later.
 */
export default function BookingPaymentWrapper({
  bookingId,
  amountCents,
  paymentMode,
  returnUrl,
  onPaymentComplete,
}: BookingPaymentWrapperProps) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  // #1976 — the charge figures the SERVER returns for this booking's payment
  // intent. chargedAmountCents is the amount actually taken today (the member
  // portion for a split); deferredGuestAmountCents is the non-member guest
  // portion charged closer to the stay. Rendered by PaymentForm instead of the
  // client-computed amountCents prop so a split parent never shows the full
  // party total against a member-portion charge.
  const [chargedAmountCents, setChargedAmountCents] = useState<number | null>(
    null,
  );
  // #1976 — the SERVER's authoritative split verdict for this intent. Forwarded
  // to PaymentForm so the split display is driven by the route, not re-derived
  // client-side from the deferred amount.
  const [isSplit, setIsSplit] = useState<boolean | null>(null);
  const [deferredGuestAmountCents, setDeferredGuestAmountCents] = useState<
    number | null
  >(null);
  const [initFailed, setInitFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const handleAlreadyComplete = useEffectEvent(() => onPaymentComplete());

  useEffect(() => {
    if (amountCents === 0) return; // No Stripe initialization needed for zero-dollar bookings

    const initializePayment = async () => {
      try {
        setLoading(true);
        setInitFailed(false);

        const endpoint = paymentMode === "setup"
          ? "/api/payments/create-setup-intent"
          : "/api/payments/create-payment-intent";

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingId }),
        });

        const data = await response.json();

        if (!response.ok) {
          // The raw provider detail (data.error) may leak partial key material;
          // log it for ops, but only ever show generic copy to the member (#1223).
          reportPaymentInitError(bookingId, data.error || "Failed to initialize payment");
          setInitFailed(true);
          return;
        }

        if (data.alreadyPaid || data.alreadySaved) {
          handleAlreadyComplete();
          return;
        }

        // #1976 — adopt the server's charge figures when present (additive
        // fields; older/other responses simply omit them and PaymentForm falls
        // back to the amountCents prop, preserving today's non-split display).
        if (typeof data.chargedAmountCents === "number") {
          setChargedAmountCents(data.chargedAmountCents);
        }
        setIsSplit(typeof data.isSplit === "boolean" ? data.isSplit : null);
        setDeferredGuestAmountCents(
          typeof data.deferredGuestAmountCents === "number"
            ? data.deferredGuestAmountCents
            : null,
        );
        setClientSecret(data.clientSecret);
      } catch (error) {
        reportPaymentInitError(bookingId, error);
        setInitFailed(true);
      } finally {
        setLoading(false);
      }
    };

    initializePayment();
  }, [bookingId, paymentMode, amountCents]);

  // Zero-dollar booking: no payment is required
  if (amountCents === 0) {
    return (
      <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">
        <p className="font-medium">Booking Complete</p>
        <p className="mt-1">No payment is required for this booking.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
        <span className="ml-3 text-gray-600">Preparing payment...</span>
      </div>
    );
  }

  if (initFailed) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        <p className="font-medium">Payment Error</p>
        <p className="mt-1">
          We couldn&apos;t start the card payment. Your booking is saved — you can
          pay later from your booking page.
        </p>
      </div>
    );
  }

  if (!clientSecret) {
    return (
      <div className="rounded-md bg-yellow-50 p-4 text-sm text-yellow-700">
        Unable to initialize payment. Please try again.
      </div>
    );
  }

  async function handlePaymentSuccess(paymentIntentId: string) {
    try {
      await fetch(`/api/bookings/${bookingId}/confirm-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentIntentId }),
      });
    } catch {
      // Non-fatal: the Stripe webhook will still reconcile the booking state.
    }

    onPaymentComplete();
  }

  return (
    <StripeProvider clientSecret={clientSecret}>
      {paymentMode === "payment" ? (
        <PaymentForm
          amountCents={amountCents}
          chargedAmountCents={chargedAmountCents}
          isSplit={isSplit}
          deferredGuestAmountCents={deferredGuestAmountCents}
          returnUrl={returnUrl}
          onSuccess={handlePaymentSuccess}
          onError={() => undefined}
        />
      ) : (
        <SetupForm
          returnUrl={returnUrl}
          onSuccess={() => onPaymentComplete()}
          onError={() => undefined}
        />
      )}
    </StripeProvider>
  );
}
