"use client";

import { useEffect, useState } from "react";

export interface XeroStatusFeatures {
  dailyMembershipRefresh: boolean;
  liveMemberGroupLookups: boolean;
  autoLoadContactGroups: boolean;
}

const DISABLED_FEATURES: XeroStatusFeatures = {
  dailyMembershipRefresh: false,
  liveMemberGroupLookups: false,
  autoLoadContactGroups: false,
};

/**
 * Loads the Xero connection state for admin UI gating.
 *
 * `connected` is `null` while the status request is in flight so callers can
 * render nothing (rather than flashing the wrong state), then `true`/`false`
 * once resolved. Any fetch failure resolves to `false`: a UI that cannot
 * confirm the connection must not offer Xero actions.
 */
export function useXeroStatus() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [features, setFeatures] =
    useState<XeroStatusFeatures>(DISABLED_FEATURES);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/xero/status")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load Xero status");
        return res.json() as Promise<{
          connected?: boolean;
          features?: Partial<XeroStatusFeatures>;
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        setConnected(Boolean(data.connected));
        setFeatures({
          dailyMembershipRefresh: Boolean(data.features?.dailyMembershipRefresh),
          liveMemberGroupLookups: Boolean(data.features?.liveMemberGroupLookups),
          autoLoadContactGroups: Boolean(data.features?.autoLoadContactGroups),
        });
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { connected, features };
}
