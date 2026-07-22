"use client";

import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements } from "@stripe/react-stripe-js";
import { ReactNode, useEffect, useMemo, useState } from "react";

/**
 * Runtime publishable-key delivery (#2082).
 *
 * `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is gone: the publishable key is fetched
 * at runtime from `/api/stripe/publishable-key` (DB-backed, the only delivery
 * path) instead of being inlined at build time. Publishable keys are not secret,
 * so plaintext runtime delivery is correct; the secret key never reaches the
 * browser. `loadStripe` is memoised per resolved key so a wizard key change is
 * picked up on the next mount without ever re-initialising for the same key.
 */

// Module-scoped cache so repeated StripeProvider mounts reuse one loadStripe
// promise per key rather than re-fetching js.stripe.com each time.
let cachedKey: string | null = null;
let cachedPromise: Promise<Stripe | null> | null = null;

function loadStripeForKey(publishableKey: string): Promise<Stripe | null> {
  if (cachedKey !== publishableKey || !cachedPromise) {
    cachedKey = publishableKey;
    cachedPromise = loadStripe(publishableKey);
  }
  return cachedPromise;
}

interface StripeProviderProps {
  children: ReactNode;
  clientSecret: string;
}

type KeyState =
  | { status: "loading" }
  | { status: "ready"; publishableKey: string }
  | { status: "unconfigured" };

/**
 * Wraps children with Stripe Elements context.
 * Requires a clientSecret from a PaymentIntent or SetupIntent.
 */
export default function StripeProvider({
  children,
  clientSecret,
}: StripeProviderProps) {
  const [keyState, setKeyState] = useState<KeyState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch("/api/stripe/publishable-key", {
          credentials: "same-origin",
        });
        const data = (await res.json().catch(() => null)) as {
          publishableKey?: string | null;
        } | null;
        if (!active) return;
        const key = data?.publishableKey;
        setKeyState(
          key ? { status: "ready", publishableKey: key } : { status: "unconfigured" },
        );
      } catch {
        if (active) setKeyState({ status: "unconfigured" });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const stripePromise = useMemo(
    () =>
      keyState.status === "ready"
        ? loadStripeForKey(keyState.publishableKey)
        : null,
    [keyState],
  );

  if (keyState.status === "loading") {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-info-7 border-t-transparent" />
        <span className="ml-3 text-muted-foreground">Preparing payment...</span>
      </div>
    );
  }

  if (!stripePromise) {
    return (
      <div className="text-danger-11 p-4">
        Stripe is not configured. Ask an administrator to complete the Stripe
        setup wizard.
      </div>
    );
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#2563eb",
            borderRadius: "8px",
          },
        },
      }}
    >
      {children}
    </Elements>
  );
}
