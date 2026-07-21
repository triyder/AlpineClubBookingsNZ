"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { IntegrationWizard } from "@/components/admin/integration-wizard";
import type { WizardStepConfig } from "@/components/admin/integration-wizard";
import {
  useXeroWizardContext,
  type XeroWizardContext,
  type XeroWizardServerConfig,
} from "./use-xero-wizard-context";
import { CreateAppStep, CredentialsStep, ConnectStep } from "./xero-wizard-steps";

/**
 * The Xero connection wizard (#2080) — a CONFIG of the reusable, provider-
 * agnostic `IntegrationWizard` shell. It supplies the Xero-derived context and
 * the three steps; the shell owns the stepper, gating, resume and the view-only
 * banner frame. C4 (Stripe) / C5 (Google) reuse the same shell with their own
 * context + steps.
 */
export function XeroSetupWizard({
  serverConfig,
}: {
  serverConfig: XeroWizardServerConfig;
}) {
  const { context, loading, refresh } = useXeroWizardContext(serverConfig);
  // The wizard lives under the finance area (same as /admin/xero). Credential
  // writes additionally require Full Admin, enforced inside the credentials step.
  const canEdit = useAdminAreaEditAccess("finance");

  // Steps are declared as data; each verifies against live server truth.
  const steps = useMemo<WizardStepConfig<XeroWizardContext>[]>(
    () => [
      {
        id: "create-app",
        title: "Create your Xero app",
        summary: "Copy exact values into the portal",
        // Instructions step — nothing to verify, so it never blocks Continue.
        isVerified: () => true,
        render: (ctx) => <CreateAppStep context={ctx} />,
      },
      {
        id: "credentials",
        title: "Enter credentials",
        summary: "Client ID + secret",
        isVerified: (ctx) =>
          ctx.credentials.client_id.set && ctx.credentials.client_secret.set,
        render: (ctx, helpers) => (
          <CredentialsStep context={ctx} helpers={helpers} />
        ),
      },
      {
        id: "connect",
        title: "Connect",
        summary: "Authorise the right organisation",
        isVerified: (ctx) => ctx.connected && !ctx.needsReentry,
        render: (ctx, helpers) => <ConnectStep context={ctx} helpers={helpers} />,
      },
    ],
    [],
  );

  // Deep-link support: a readiness "blocked" link or the modules "Set up" CTA can
  // target a step via ?step=; the shell clamps it to the furthest reachable step.
  const searchParams = useSearchParams();
  const initialStepId = searchParams.get("step") ?? undefined;

  return (
    <IntegrationWizard<XeroWizardContext>
      wizardId="xero"
      title="Xero setup"
      description="Create a Xero app, enter its credentials, and connect your organisation — all in-app."
      steps={steps}
      context={context}
      contextLoading={loading}
      onRefresh={refresh}
      canEdit={canEdit}
      initialStepId={initialStepId}
      // The wizard connects Xero, but account/item mappings and contact import
      // still follow below — so the final state must read as "connected, more to
      // configure", never "the whole integration is done" (#2080 UX-F9).
      completion={{
        badgeLabel: "Connected",
        message: "Connected",
        hint: "Configure account mappings and run contact import below to finish setting up Xero.",
      }}
      viewOnlyBanner={
        <>
          Your admin role can view Xero setup, but changing credentials and
          connecting requires finance edit access (entering credentials requires
          Full Admin).
        </>
      }
    />
  );
}
