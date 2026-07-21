/**
 * Xero OAuth lifecycle
 *
 * Builds the consent URL, handles the OAuth callback, exposes client construction
 * for higher-level Xero infrastructure, and disconnects (revoke + clear tokens).
 */

import { XeroClient } from "xero-node";
import { getOperationalXeroConfig } from "@/lib/xero-config";
import {
  deleteXeroTokens,
  loadXeroTokens,
  saveXeroTokens,
} from "./xero-token-store";

export async function createXeroClient(state?: string): Promise<XeroClient> {
  return new XeroClient({
    ...(await getOperationalXeroConfig()),
    ...(state ? { state } : {}),
  });
}

/**
 * Build the Xero OAuth2 consent URL for admin to connect.
 */
export async function getXeroConsentUrl(state?: string): Promise<string> {
  const xero = await createXeroClient(state);
  await xero.initialize();
  return xero.buildConsentUrl();
}

/**
 * Handle the OAuth2 callback from Xero.
 * Exchanges the authorization code for tokens and stores them encrypted.
 */
export async function handleXeroCallback(url: string, state?: string): Promise<void> {
  const xero = await createXeroClient(state);
  await xero.initialize();
  const tokenSet = await xero.apiCallback(url);
  await xero.updateTenants();

  const tenants = xero.tenants;
  const tenantId = tenants.length > 0 ? tenants[0].tenantId : null;
  if (!tenantId) {
    throw new Error(
      "Xero did not return an organisation to connect. Please reconnect and choose the club organisation in Xero."
    );
  }

  await saveXeroTokens({
    accessToken: tokenSet.access_token!,
    refreshToken: tokenSet.refresh_token!,
    expiresAt: new Date(Date.now() + (tokenSet.expires_in ?? 1800) * 1000),
    tenantId,
  });
}

/**
 * Disconnect Xero by revoking stored tokens (best-effort) and removing them locally.
 */
export async function disconnectXero(): Promise<void> {
  const tokens = await loadXeroTokens();
  if (tokens) {
    try {
      const xero = await createXeroClient();
      await xero.initialize();
      xero.setTokenSet({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "Bearer",
      });
      await xero.revokeToken();
    } catch {
      // Best-effort revocation; continue with local cleanup
    }
  }
  await deleteXeroTokens();
}
