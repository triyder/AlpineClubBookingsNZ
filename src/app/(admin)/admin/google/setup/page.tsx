import type { Metadata } from "next";
import { BackLink } from "@/components/admin/back-link";
import { detectLegacyProviderEnv } from "@/lib/xero-config";
import { GOOGLE_PROVIDER } from "@/lib/google-config";
import { GoogleSetupWizard } from "./google-setup-wizard";

export const metadata: Metadata = {
  title: "Google sign-in setup",
};

const GOOGLE_CALLBACK_PATH = "/api/auth/callback/google";

/**
 * Derive the Google OAuth authorized redirect URI from NEXTAUTH_URL:
 * `{origin}/api/auth/callback/google` — the exact production callback the Google
 * provider uses. Returns "" when NEXTAUTH_URL is absent/invalid (the wizard then
 * shows guidance to set it) — never a localhost fallback that would break a real
 * deployment or, worse, be pasted into Google Cloud.
 */
function getGoogleRedirectUri(): string {
  const nextAuthUrl = process.env.NEXTAUTH_URL?.trim();
  if (!nextAuthUrl) return "";
  try {
    return `${new URL(nextAuthUrl).origin}${GOOGLE_CALLBACK_PATH}`;
  } catch {
    return "";
  }
}

// Server component: resolves the server-derived setup config (the redirect URI,
// legacy env detection) once, then renders the interactive wizard. Reached from
// the Integrations hub, the Login & Security card, and the Modules page.
export default function GoogleSetupPage() {
  const redirectUri = getGoogleRedirectUri();
  const legacyEnvVars =
    detectLegacyProviderEnv().find((f) => f.provider === GOOGLE_PROVIDER)
      ?.vars ?? [];

  return (
    <div className="max-w-6xl p-6">
      <BackLink href="/admin/integrations" label="Integrations" />
      <h1 className="mt-2 mb-2 text-2xl font-bold">Google sign-in setup</h1>
      <p className="mb-6 text-muted-foreground">
        Let members sign in with a Google account they have linked from their
        profile. Set it up here, then turn it on from the Login &amp; Security
        page. Google sign-in never replaces password sign-in.
      </p>

      <GoogleSetupWizard serverConfig={{ redirectUri, legacyEnvVars }} />
    </div>
  );
}
