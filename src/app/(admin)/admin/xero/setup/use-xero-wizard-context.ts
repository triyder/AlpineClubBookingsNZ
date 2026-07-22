"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { isFullAdmin } from "@/lib/access-roles";

/**
 * Derives the Xero setup wizard's server truth (#2080) — the `context` the
 * reusable shell verifies each step against. Everything here is LIVE server
 * state (credential metadata, connection status, connected org name), so step
 * gating can never be faked by a stale persisted cursor.
 */

export interface XeroCredentialFieldMeta {
  set: boolean;
  setAt: string | null;
}

export type XeroCredentialKey = "client_id" | "client_secret" | "webhook_key";

export interface XeroWizardContext {
  /** Resolved OAuth redirect URI (from NEXTAUTH_URL, server-provided). */
  redirectUri: string;
  /** Company URL suggestion — the deployment origin behind the redirect URI. */
  companyUrl: string;
  /** Legacy XERO_* env vars still present (server-detected); empty when clean. */
  legacyEnvVars: string[];
  /** Metadata-only credential status (never a value). */
  credentials: Record<XeroCredentialKey, XeroCredentialFieldMeta>;
  /** Whether the viewer may write credentials (Full Admin only). */
  isFullAdmin: boolean;
  /** Xero OAuth connection state. */
  connected: boolean;
  /** Stored tokens exist but no longer decrypt (auth secret changed). */
  needsReentry: boolean;
  /** Connected organisation name for the right-org confirmation, when known. */
  orgName: string | null;
  /** Webhook delivery URL to paste into the Xero portal ({origin}/api/webhooks/xero). */
  webhookDeliveryUrl: string;
  /**
   * Whether this deployment can actually verify webhooks: a public HTTPS origin
   * (not localhost / not plain HTTP). When false the step explains why and
   * defaults to Skip.
   */
  webhooksVerifiable: boolean;
  /** Persistent webhook verification (marker matches the current key). */
  webhookVerified: boolean;
}

const CREDENTIALS_ENDPOINT = "/api/admin/integrations/credentials?provider=xero";
const STATUS_ENDPOINT = "/api/admin/xero/status";
const ORG_ENDPOINT = "/api/admin/xero/organisation";
const WEBHOOK_STATUS_ENDPOINT = "/api/admin/xero/webhook/verify-status";

const EMPTY_META: XeroCredentialFieldMeta = { set: false, setAt: null };

interface CredentialsResponse {
  credentials?: Record<string, { set?: boolean; setAt?: string }>;
}
interface StatusResponse {
  connected?: boolean;
  needsReentry?: boolean;
}
interface OrgResponse {
  name?: string | null;
}
interface WebhookStatusResponse {
  verified?: boolean;
}

export interface XeroWizardServerConfig {
  redirectUri: string;
  companyUrl: string;
  legacyEnvVars: string[];
  /** {origin}/api/webhooks/xero, or "" when no NEXTAUTH_URL origin is resolvable. */
  webhookDeliveryUrl: string;
  /** Public-HTTPS, non-localhost origin (webhooks can actually validate here). */
  webhooksVerifiable: boolean;
}

export function useXeroWizardContext(serverConfig: XeroWizardServerConfig): {
  context: XeroWizardContext;
  loading: boolean;
  refresh: () => void;
} {
  const { data: session } = useSession();
  const isFull = session
    ? isFullAdmin({ accessRoles: session.user?.accessRoles ?? [] })
    : false;

  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState<
    Record<XeroCredentialKey, XeroCredentialFieldMeta>
  >({
    client_id: EMPTY_META,
    client_secret: EMPTY_META,
    webhook_key: EMPTY_META,
  });
  const [connected, setConnected] = useState(false);
  const [needsReentry, setNeedsReentry] = useState(false);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [webhookVerified, setWebhookVerified] = useState(false);

  const load = useCallback(async (forceOrgRefresh = false) => {
    try {
      const [credRes, statusRes, webhookRes] = await Promise.all([
        fetch(CREDENTIALS_ENDPOINT, { credentials: "same-origin" }),
        fetch(STATUS_ENDPOINT, { credentials: "same-origin" }),
        fetch(WEBHOOK_STATUS_ENDPOINT, { credentials: "same-origin" }),
      ]);

      if (credRes.ok) {
        const data = (await credRes.json()) as CredentialsResponse;
        const rows = data.credentials ?? {};
        setCredentials({
          client_id: {
            set: Boolean(rows.client_id?.set),
            setAt: rows.client_id?.setAt ?? null,
          },
          client_secret: {
            set: Boolean(rows.client_secret?.set),
            setAt: rows.client_secret?.setAt ?? null,
          },
          webhook_key: {
            set: Boolean(rows.webhook_key?.set),
            setAt: rows.webhook_key?.setAt ?? null,
          },
        });
      }

      let isConnected = false;
      if (statusRes.ok) {
        const data = (await statusRes.json()) as StatusResponse;
        isConnected = Boolean(data.connected);
        setConnected(isConnected);
        setNeedsReentry(Boolean(data.needsReentry));
      }

      if (webhookRes.ok) {
        const data = (await webhookRes.json()) as WebhookStatusResponse;
        setWebhookVerified(Boolean(data.verified));
      }

      // Only read the org (a Xero API call) when actually connected. An explicit
      // refresh (post-connect return, post-credential save) forces a fresh read
      // (?refresh=1) so a just-reconnected DIFFERENT org can never show the old
      // cached name — belt-and-braces over the server-side cache reset (#2080 F1).
      if (isConnected) {
        const orgUrl = forceOrgRefresh
          ? `${ORG_ENDPOINT}?refresh=1`
          : ORG_ENDPOINT;
        const orgRes = await fetch(orgUrl, { credentials: "same-origin" });
        if (orgRes.ok) {
          const data = (await orgRes.json()) as OrgResponse;
          setOrgName(data.name ?? null);
        }
      } else {
        setOrgName(null);
      }
    } catch {
      // Leave the last-known state; the wizard degrades to "not verified".
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A user-triggered refresh always forces a fresh org read (the only callers
  // are post-connect and post-credential-save, where the org identity may have
  // just changed); the initial mount load uses the cache.
  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  const context: XeroWizardContext = {
    redirectUri: serverConfig.redirectUri,
    companyUrl: serverConfig.companyUrl,
    legacyEnvVars: serverConfig.legacyEnvVars,
    credentials,
    isFullAdmin: isFull,
    connected,
    needsReentry,
    orgName,
    webhookDeliveryUrl: serverConfig.webhookDeliveryUrl,
    webhooksVerifiable: serverConfig.webhooksVerifiable,
    webhookVerified,
  };

  return { context, loading, refresh };
}
