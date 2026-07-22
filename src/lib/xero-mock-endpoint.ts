/**
 * TEST-ONLY Xero endpoint seam for the mock-Xero E2E harness (#2080).
 *
 * PRODUCTION-INERT BY CONSTRUCTION: every function here short-circuits to a
 * no-op / undefined unless `XERO_MOCK_API_ORIGIN` is set in the environment.
 * That variable is NEVER set in a real deployment — it is set only by the E2E
 * staging stack (.env.staging) and points at the app's OWN origin so the app
 * drives a set of gated mock endpoints (`/api/testing/xero-mock/*`) instead of
 * the real identity.xero.com / api.xero.com. When it is unset, the OAuth and
 * organisation code paths run exactly as before through `xero-node` — this
 * module contributes nothing.
 *
 * The mock deliberately mirrors only what steps 1–3 of the wizard exercise
 * (consent redirect, token exchange, connections, organisation). C3 extends the
 * gated route handlers with a webhook-validation ping and chart of accounts;
 * this seam does not need to change for that.
 */

import {
  saveXeroTokens,
} from "@/lib/xero-token-store";
import { getOperationalXeroRedirectUri } from "@/lib/xero-config";

const MOCK_BASE_PATH = "/api/testing/xero-mock";

// Fixed fixture identity the gated mock endpoints return, shared with the
// Playwright spec so it can assert the wizard confirms the RIGHT org.
export const MOCK_XERO_TENANT_ID = "mock-tenant-0001";
export const MOCK_XERO_ORG_NAME = "Alpine Test Club Ltd";
export const MOCK_XERO_ORG_FINANCIAL_YEAR_END_MONTH = 3;

/**
 * True in a REAL production runtime (never the E2E staging stack). Used as a
 * hard backstop so the mock stays inert even if `XERO_MOCK_API_ORIGIN` ever
 * leaked into a genuine deployment (#2080 review, CORRECTNESS-F2).
 *
 * NOTE: the E2E staging stack legitimately runs the PRODUCTION build
 * (`NODE_ENV=production`, `node server.js`) with the mock enabled, so
 * `NODE_ENV` alone cannot be the gate — it would disable the E2E happy-path.
 * The staging stack is distinguished by `APP_RUNTIME_ROLE=staging`
 * (docker-compose.staging.yml); real production roles are `web-blue` /
 * `web-green` / `cron-leader`. So "real production" is a production build whose
 * runtime role is NOT the staging harness.
 */
export function isRealProductionRuntime(): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    process.env.APP_RUNTIME_ROLE !== "staging"
  );
}

/**
 * The mock Xero API origin, or undefined in every real deployment. When defined,
 * the OAuth/organisation code routes through the gated mock endpoints instead of
 * the live Xero servers.
 *
 * Two independent conditions must BOTH hold: `XERO_MOCK_API_ORIGIN` is set AND
 * this is not a real production runtime. Either alone leaves the mock inert.
 */
export function getXeroMockApiOrigin(): string | undefined {
  if (isRealProductionRuntime()) return undefined;
  const raw = process.env.XERO_MOCK_API_ORIGIN?.trim();
  return raw ? raw : undefined;
}

/** True when the mock harness is active (test env only). */
export function isXeroMockActive(): boolean {
  return getXeroMockApiOrigin() !== undefined;
}

/**
 * The origin SERVER-SIDE mock consumers (token exchange, organisation fetch)
 * should call, or undefined whenever the mock is inactive.
 *
 * `XERO_MOCK_API_ORIGIN` is the BROWSER-facing origin (the consent URL the
 * operator's browser navigates to). In the CI E2E stack the app is exposed on
 * the host as :3001 but listens in-container on :3000, so a server-side fetch
 * of the browser origin would dial a port nothing listens on inside the
 * container. `XERO_MOCK_INTERNAL_ORIGIN` carries the in-container self-origin
 * for those calls; it defaults to the browser origin so single-port local
 * setups need only one variable. Gated identically — inert unless the mock as
 * a whole is active.
 */
export function getXeroMockInternalOrigin(): string | undefined {
  const publicOrigin = getXeroMockApiOrigin();
  if (!publicOrigin) return undefined;
  const raw = process.env.XERO_MOCK_INTERNAL_ORIGIN?.trim();
  return raw ? raw : publicOrigin;
}

function mockUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}${MOCK_BASE_PATH}${path}`;
}

/**
 * Mock consent URL: points at the gated authorize endpoint, which immediately
 * redirects back to our real callback with a code + the same state, so the
 * existing callback route and its state-cookie check are exercised unchanged.
 */
export function buildMockXeroConsentUrl(origin: string, state?: string): string {
  const redirectUri = getOperationalXeroRedirectUri();
  const params = new URLSearchParams({ redirect_uri: redirectUri });
  if (state) params.set("state", state);
  return `${mockUrl(origin, "/authorize")}?${params.toString()}`;
}

/**
 * Mock token exchange + tenant read for the OAuth callback: swaps the code for a
 * token set and reads the mock connection, then stores tokens exactly like the
 * real path. Mirrors `handleXeroCallback` so the wizard's step 3 completes.
 */
export async function handleMockXeroCallback(
  origin: string,
  callbackUrl: string,
): Promise<void> {
  const code = new URL(callbackUrl).searchParams.get("code") ?? "mock-code";

  const tokenRes = await fetch(mockUrl(origin, "/token"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!tokenRes.ok) {
    throw new Error("Mock Xero token exchange failed.");
  }
  const tokenSet = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
  };

  const connRes = await fetch(mockUrl(origin, "/connections"));
  if (!connRes.ok) {
    throw new Error("Mock Xero connections read failed.");
  }
  const connections = (await connRes.json()) as Array<{ tenantId: string }>;
  const tenantId = connections[0]?.tenantId ?? null;
  if (!tenantId) {
    throw new Error(
      "Xero did not return an organisation to connect. Please reconnect and choose the club organisation in Xero.",
    );
  }

  await saveXeroTokens({
    accessToken: tokenSet.access_token,
    refreshToken: tokenSet.refresh_token,
    expiresAt: new Date(Date.now() + (tokenSet.expires_in ?? 1800) * 1000),
    tenantId,
  });
}

// Fixture chart of accounts + items the gated mock endpoints return, shared with
// the mapping-step E2E so it can assert the wizard renders real-looking pickers.
// Kept deliberately small — enough to cover the REVENUE/EXPENSE/BANK types the
// account-mapping rows filter on, plus a couple of sold items.
export const MOCK_XERO_ACCOUNTS = [
  { code: "200", name: "Hut Fees Income", type: "REVENUE", class: "REVENUE" },
  { code: "260", name: "Subscription Income", type: "REVENUE", class: "REVENUE" },
  { code: "404", name: "Bank Fees", type: "EXPENSE", class: "EXPENSE" },
  { code: "090", name: "Business Bank Account", type: "BANK", class: "ASSET" },
] as const;

export const MOCK_XERO_ITEMS = [
  {
    itemID: "item-hut-fee",
    code: "HUT",
    name: "Hut Fee",
    description: "Overnight hut fee",
  },
  {
    itemID: "item-joining",
    code: "JOIN",
    name: "Joining Fee",
    description: "Membership joining fee",
  },
] as const;

/** Mock chart-of-accounts read for the mapping step. */
export async function fetchMockChartOfAccounts(
  origin: string,
): Promise<Array<{ code: string; name: string; type: string; class: string }>> {
  const res = await fetch(mockUrl(origin, "/chart-of-accounts"));
  if (!res.ok) return [];
  return (await res.json()) as Array<{
    code: string;
    name: string;
    type: string;
    class: string;
  }>;
}

/** Mock items read for the mapping step. */
export async function fetchMockXeroItems(
  origin: string,
): Promise<
  Array<{ itemID: string; code: string; name: string; description: string }>
> {
  const res = await fetch(mockUrl(origin, "/items"));
  if (!res.ok) return [];
  return (await res.json()) as Array<{
    itemID: string;
    code: string;
    name: string;
    description: string;
  }>;
}

export interface MockXeroOrganisation {
  name: string | null;
  financialYearEndMonth: number | null;
}

/** Mock organisation read for the step-3 "right org?" confirmation. */
export async function fetchMockXeroOrganisation(
  origin: string,
): Promise<MockXeroOrganisation> {
  const res = await fetch(mockUrl(origin, "/organisation"));
  if (!res.ok) {
    return { name: null, financialYearEndMonth: null };
  }
  const body = (await res.json()) as MockXeroOrganisation;
  const month =
    typeof body.financialYearEndMonth === "number" &&
    body.financialYearEndMonth >= 1 &&
    body.financialYearEndMonth <= 12
      ? body.financialYearEndMonth
      : null;
  return { name: body.name ?? null, financialYearEndMonth: month };
}
