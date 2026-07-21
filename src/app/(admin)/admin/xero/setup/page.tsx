import {
  detectLegacyProviderEnv,
  getOperationalXeroRedirectUri,
} from "@/lib/xero-config";
import { XeroSetupPageClient } from "../_components/xero-setup-page-client";

// Server component: resolves the server-derived setup config (the C1 redirect
// URI, legacy env detection) once, then renders the interactive client body.
// The guided wizard (#2080) is the credential-entry + connect surface; it
// supersedes the interim credentials section from C1.
export default function XeroSetupPage() {
  const redirectUri = getOperationalXeroRedirectUri();
  const companyUrl = redirectUri ? new URL(redirectUri).origin : "";
  const legacyEnvVars =
    detectLegacyProviderEnv().find((f) => f.provider === "xero")?.vars ?? [];

  // Webhook delivery URL + whether this deployment can validate webhooks at all.
  // Xero only reaches a PUBLIC HTTPS origin; a localhost/plain-HTTP deployment
  // (typical dev/self-host-behind-tunnel-not-yet) can store a key but can never
  // receive the intent-to-receive ping, so the step there defaults to Skip.
  const webhookDeliveryUrl = companyUrl ? `${companyUrl}/api/webhooks/xero` : "";
  const webhooksVerifiable = isPublicHttpsOrigin(companyUrl);

  return (
    <XeroSetupPageClient
      serverConfig={{
        redirectUri,
        companyUrl,
        legacyEnvVars,
        webhookDeliveryUrl,
        webhooksVerifiable,
      }}
    />
  );
}

/** True only for an https:// origin whose host is not localhost/loopback. */
function isPublicHttpsOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host !== "localhost" &&
      host !== "127.0.0.1" &&
      host !== "::1" &&
      host !== "[::1]" &&
      !host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
