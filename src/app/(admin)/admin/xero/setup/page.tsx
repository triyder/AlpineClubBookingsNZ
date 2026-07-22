import {
  detectLegacyProviderEnv,
  getOperationalXeroRedirectUri,
  getXeroWebhooksVerifiable,
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
  // Shared derivation (src/lib/xero-config) so the wizard step, this page, and
  // the verify-status route / amber badge all agree on verifiability.
  const webhooksVerifiable = getXeroWebhooksVerifiable();

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
