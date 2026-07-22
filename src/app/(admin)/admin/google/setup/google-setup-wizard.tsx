"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { IntegrationWizard } from "@/components/admin/integration-wizard";
import type { WizardStepConfig } from "@/components/admin/integration-wizard";
import {
  useGoogleWizardContext,
  type GoogleWizardContext,
  type GoogleWizardServerConfig,
} from "./use-google-wizard-context";
import {
  PortalGuideStep,
  CredentialsStep,
  VerifyStep,
} from "./google-wizard-steps";

/**
 * The Google sign-in setup wizard (#2087) — a CONFIG of the reusable, provider-
 * agnostic `IntegrationWizard` shell (built by C2, #2080). It supplies the
 * Google-derived context and three steps (OAuth-client guide, write-only
 * credential capture, real OAuth verify round-trip); the shell owns the stepper,
 * gating, resume and the view-only banner frame. The credential + verify steps
 * are hard-gated: the module toggle stays locked until the verify passes (D2),
 * and replacing a credential re-locks it (verify-reset).
 */
export function GoogleSetupWizard({
  serverConfig,
}: {
  serverConfig: GoogleWizardServerConfig;
}) {
  const { context, loading, refresh } = useGoogleWizardContext(serverConfig);
  // The wizard lives under the finance area (same as /admin/xero, /admin/stripe,
  // and the shared wizard-progress cursor). Credential writes + verification
  // additionally require Full Admin, enforced inside the steps and by the API.
  const canEdit = useAdminAreaEditAccess("finance");

  const steps = useMemo<WizardStepConfig<GoogleWizardContext>[]>(
    () => [
      {
        id: "create-client",
        title: "Create OAuth client",
        summary: "In Google Cloud Console",
        isVerified: () => true,
        render: (ctx) => <PortalGuideStep context={ctx} />,
      },
      {
        id: "credentials",
        title: "Enter credentials",
        summary: "Client ID + secret",
        isVerified: (ctx) =>
          ctx.credentials.client_id.set &&
          ctx.credentials.client_secret.set &&
          !ctx.needsReentry,
        render: (ctx, helpers) => (
          <CredentialsStep context={ctx} helpers={helpers} />
        ),
      },
      {
        id: "verify",
        title: "Verify",
        summary: "Real OAuth round-trip",
        isVerified: (ctx) => ctx.verified,
        render: (ctx, helpers) => (
          <VerifyStep context={ctx} helpers={helpers} />
        ),
      },
    ],
    [],
  );

  const searchParams = useSearchParams();
  const initialStepId = searchParams.get("step") ?? undefined;

  return (
    <IntegrationWizard<GoogleWizardContext>
      wizardId="google"
      title="Google sign-in setup"
      description="Create a Google OAuth client, enter its credentials, and verify a real sign-in round-trip — all in-app, no environment variables or restart."
      steps={steps}
      context={context}
      contextLoading={loading}
      onRefresh={refresh}
      canEdit={canEdit}
      initialStepId={initialStepId}
      completion={{
        badgeLabel: "Verified",
        message: "Google sign-in verified",
        hint: "Turn it on from the Login & Security page to show the button.",
      }}
      viewOnlyBanner={
        <>
          Your admin role can view Google setup, but entering credentials and
          verifying requires finance edit access (and Full Admin to write
          credentials).
        </>
      }
    />
  );
}
