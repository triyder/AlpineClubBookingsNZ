"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

const WEBHOOK_STATUS_ENDPOINT = "/api/admin/xero/webhook/verify-status";

/**
 * Persistent amber badge (#2081): "Webhooks not configured — payment updates
 * rely on scheduled sync." Shown on /admin/xero and /admin/xero/setup whenever
 * Xero is connected but webhooks are not verified (the stored key has no
 * matching intent-to-receive marker — including after a key replace re-arms
 * verification). A later successful verify clears it everywhere, because both
 * pages read the same server state.
 *
 * Only renders once we've confirmed NOT-verified, so a verified club never sees
 * a flash of amber.
 */
export function WebhookAmberBadge({ connected }: { connected: boolean }) {
  const [verified, setVerified] = useState<boolean | null>(null);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch(WEBHOOK_STATUS_ENDPOINT, {
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { verified?: boolean };
        if (active) setVerified(Boolean(data.verified));
      } catch {
        // Leave unknown — the badge stays hidden rather than false-alarming.
      }
    })();
    return () => {
      active = false;
    };
  }, [connected]);

  if (!connected || verified !== false) return null;

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        Webhooks not configured — payment updates rely on scheduled sync. Finish
        setup on the{" "}
        <Link
          href="/admin/xero/setup?step=webhooks"
          className="font-medium text-amber-900 underline underline-offset-2"
        >
          Xero Setup
        </Link>{" "}
        page to get real-time updates.
      </span>
    </div>
  );
}
