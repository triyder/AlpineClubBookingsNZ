import { NextResponse } from "next/server";
import { getOperationalStripePublishableKey } from "@/lib/stripe-config";

/**
 * Runtime delivery of the Stripe PUBLISHABLE key (#2082).
 *
 * With `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` dropped entirely, the DB-managed
 * store is the ONLY source and this endpoint is the ONLY delivery path — no
 * build-time inlining, no dual-path logic. The publishable key is NOT secret
 * (it identifies the account to Stripe.js and is designed to ship to browsers),
 * so plaintext delivery over a public, session-free route is correct here. The
 * SECRET key and webhook secret never travel this way — they are resolved only
 * server-side and are excluded by construction.
 *
 * A resolver error must not 500 the checkout surfaces: we fail soft to
 * `{ publishableKey: null }` so StripeProvider renders its "not configured"
 * state rather than crashing the page.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  let publishableKey: string | null = null;
  try {
    publishableKey = (await getOperationalStripePublishableKey()) ?? null;
  } catch {
    publishableKey = null;
  }

  return NextResponse.json(
    { publishableKey },
    {
      // Short private cache: the key is stable but can change via the wizard
      // (verify-reset), and it is per-deployment, not per-user.
      headers: { "Cache-Control": "private, max-age=60" },
    },
  );
}
