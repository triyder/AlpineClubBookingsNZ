import { createHmac, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { getOperationalXeroWebhookKey } from "@/lib/xero-config";
import { getXeroMockInternalOrigin } from "@/lib/xero-mock-endpoint";
import { mockDisabledResponse } from "../_guard";

// Mock Xero intent-to-receive (ITR) validation ping (#2081). Simulates Xero's
// OWN servers sending the empty-events validation POST to our REAL webhook
// route: it resolves the stored webhook key via the production resolver, signs
// an empty-events body with it, and POSTs the real `/api/webhooks/xero` handler.
//
// This deliberately exercises the SAME resolver + HMAC + marker path production
// uses, so the wizard's Verify goes green only against a genuine round-trip. The
// webhook key is resolved server-side and never returned. Test-only; 404 in
// production (triple-gated inertness pattern, like the other mock endpoints).
export async function POST() {
  const disabled = mockDisabledResponse();
  if (disabled) return disabled;

  // Server-side POST to our own webhook route — use the in-container origin
  // (the browser-facing origin may be a host-mapped port the container can't
  // dial; see getXeroMockInternalOrigin).
  const origin = getXeroMockInternalOrigin();
  if (!origin) {
    return NextResponse.json({ error: "mock origin unset" }, { status: 400 });
  }

  const webhookKey = await getOperationalXeroWebhookKey();
  if (!webhookKey) {
    // The wizard must save the webhook key before triggering the ping.
    return NextResponse.json(
      { error: "webhook key not configured" },
      { status: 400 },
    );
  }

  // Xero's ITR request is an empty events array. `entropy` keeps each ping's
  // body (and therefore its signature) unique, mirroring the real payload shape.
  const body = JSON.stringify({
    events: [],
    firstEventSequence: 0,
    lastEventSequence: 0,
    entropy: randomBytes(8).toString("hex"),
  });
  const signature = createHmac("sha256", webhookKey).update(body).digest("base64");

  const res = await fetch(`${origin.replace(/\/$/, "")}/api/webhooks/xero`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-xero-signature": signature,
    },
    body,
  });

  return NextResponse.json({ forwarded: res.status });
}
