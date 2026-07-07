function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export const XERO_REPORT_OAUTH_SCOPES = {
  profitAndLoss: "accounting.reports.profitandloss.read",
  balanceSheet: "accounting.reports.balancesheet.read",
  bankSummary: "accounting.reports.banksummary.read",
} as const;

export const XERO_REQUIRED_REPORT_OAUTH_SCOPES = Object.values(
  XERO_REPORT_OAUTH_SCOPES,
);

const OPERATIONAL_XERO_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.payments",
  "accounting.settings.read",
  // Required by the finance dashboard sync. Existing tokens keep their old
  // scopes until Xero is reconnected from the admin panel, so a one-time
  // re-consent is needed when this list changes.
  ...XERO_REQUIRED_REPORT_OAUTH_SCOPES,
  "offline_access",
] as const;

const DEFAULT_OPERATIONAL_XERO_REDIRECT_URI =
  "http://localhost:3000/api/admin/xero/callback";

// xero-node defaults its OAuth-layer HTTP timeout (identity.xero.com
// discovery and token requests) to 3500ms, which is tight enough that a
// routine slow round trip fails the whole client build.
const DEFAULT_XERO_HTTP_TIMEOUT_MS = 10_000;

function getXeroHttpTimeoutMs(): number {
  const raw = readEnv("XERO_HTTP_TIMEOUT_MS");
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_XERO_HTTP_TIMEOUT_MS;
}

interface XeroClientConfigOptions {
  clientIdEnv: string;
  clientSecretEnv: string;
  redirectUriEnv: string;
  defaultRedirectUri: string;
  scopes: readonly string[];
}

function buildXeroClientConfig({
  clientIdEnv,
  clientSecretEnv,
  redirectUriEnv,
  defaultRedirectUri,
  scopes,
}: XeroClientConfigOptions) {
  return {
    clientId: readEnv(clientIdEnv) ?? "",
    clientSecret: readEnv(clientSecretEnv) ?? "",
    redirectUris: [readEnv(redirectUriEnv) ?? defaultRedirectUri],
    scopes: [...scopes],
    httpTimeout: getXeroHttpTimeoutMs(),
  };
}

export function getOperationalXeroConfig() {
  return buildXeroClientConfig({
    clientIdEnv: "XERO_CLIENT_ID",
    clientSecretEnv: "XERO_CLIENT_SECRET",
    redirectUriEnv: "XERO_REDIRECT_URI",
    defaultRedirectUri: DEFAULT_OPERATIONAL_XERO_REDIRECT_URI,
    scopes: OPERATIONAL_XERO_OAUTH_SCOPES,
  });
}

export function getOperationalXeroEncryptionKey(): string | undefined {
  return readEnv("XERO_ENCRYPTION_KEY");
}
