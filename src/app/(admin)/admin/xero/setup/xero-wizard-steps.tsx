"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyField } from "@/components/admin/integration-wizard";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";
import { ConnectionStatusPanel } from "../_components/connection-status-panel";
import { useXeroConnection } from "../_hooks/use-xero-connection";
import type { XeroWizardContext } from "./use-xero-wizard-context";

const CREDENTIALS_ENDPOINT = "/api/admin/integrations/credentials";
const CONNECT_RETURN = "/admin/xero/setup";

function formatSetAt(setAt: string | null): string {
  if (!setAt) return "";
  const date = new Date(setAt);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en-NZ", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

function LegacyEnvWarning({ vars }: { vars: string[] }) {
  if (vars.length === 0) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        These legacy environment variables are no longer used and are ignored:{" "}
        <code className="rounded bg-warning-3 px-1">{vars.join(", ")}</code>.
        Enter the credentials in-app here, then remove them from the environment.
      </span>
    </div>
  );
}

/** Step 1 — "Create your Xero app": portal-mirroring instructions + copy fields. */
export function CreateAppStep({ context }: { context: XeroWizardContext }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Create your Xero app
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          In a new tab, open the{" "}
          <a
            href="https://developer.xero.com/app/manage"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
          >
            Xero developer portal
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>{" "}
          and choose <strong>New app</strong> &rarr; <strong>Web app</strong>.
          Use the exact values below — copy each one so nothing is mistyped.
        </p>
      </div>

      <LegacyEnvWarning vars={context.legacyEnvVars} />

      <CopyField
        label="App name (suggested)"
        value="Club Bookings"
        monospace={false}
        description="Any name works; this is just what shows in your Xero developer portal."
      />
      <CopyField
        label="Company or application URL"
        value={context.companyUrl}
        emptyHint="Set NEXTAUTH_URL to your site URL to fill this in."
        description="Your booking site's address."
      />
      <CopyField
        label="OAuth 2.0 redirect URI"
        value={context.redirectUri}
        emptyHint="Set NEXTAUTH_URL so the redirect URI can be derived."
        description="Paste this EXACTLY into the Redirect URIs field. It must match what the app sends, or Xero rejects the connection."
      />

      <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Which scopes / sections?</p>
        <p className="mt-1">
          One app covers everything this integration needs — contacts, invoices,
          payments, settings and finance reports. You do not create separate apps
          for accounting and finance; the connection step requests the right
          scopes for you.
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        When the app is created, Xero shows a <strong>Client id</strong> and lets
        you generate a <strong>Client secret</strong>. Keep that tab open and
        continue to the next step to enter them here.
      </p>
    </div>
  );
}

/** Step 2 — "Enter credentials": write-only Client ID / Secret → C1 API. */
export function CredentialsStep({
  context,
  helpers,
}: {
  context: XeroWizardContext;
  helpers: WizardStepHelpers;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const canWrite = context.isFullAdmin;
  const bothSet =
    context.credentials.client_id.set && context.credentials.client_secret.set;

  async function writeField(key: string, value: string): Promise<void> {
    const res = await fetch(CREDENTIALS_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "xero", key, value }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(data?.error || `Failed to save ${key}.`);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      // Write only the fields the operator actually filled in (Replace flow).
      if (clientId.trim()) await writeField("client_id", clientId.trim());
      if (clientSecret.trim())
        await writeField("client_secret", clientSecret.trim());
      setClientId("");
      setClientSecret("");
      setSuccess(
        "Credentials saved. Any existing Xero connection was reset — reconnect on the next step.",
      );
      helpers.refresh();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save.",
      );
    } finally {
      setSaving(false);
    }
  }

  const dirty = Boolean(clientId.trim() || clientSecret.trim());

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Enter your Xero credentials
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste the Client id and generate a Client secret in your Xero app, then
          enter them here. They are encrypted at rest and never shown again —
          entering a new value replaces the old one and{" "}
          <strong>resets the Xero connection</strong> (you re-connect on the next
          step).
        </p>
      </div>

      <LegacyEnvWarning vars={context.legacyEnvVars} />

      {!canWrite ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Only a <strong>Full Admin</strong> can enter or replace Xero
            credentials. You can view the status here.
          </span>
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="xero-wizard-client-id">Client ID</Label>
          <span className="text-xs">
            {context.credentials.client_id.set ? (
              <span className="text-success-11">
                Set ✓{" "}
                {formatSetAt(context.credentials.client_id.setAt)}
              </span>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </span>
        </div>
        <Input
          id="xero-wizard-client-id"
          type="text"
          autoComplete="off"
          placeholder={
            context.credentials.client_id.set
              ? "Enter a new value to replace"
              : "Xero app client ID"
          }
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          disabled={!canWrite || saving}
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="xero-wizard-client-secret">Client Secret</Label>
          <span className="text-xs">
            {context.credentials.client_secret.set ? (
              <span className="text-success-11">
                Set ✓{" "}
                {formatSetAt(context.credentials.client_secret.setAt)}
              </span>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </span>
        </div>
        <Input
          id="xero-wizard-client-secret"
          type="password"
          autoComplete="off"
          placeholder={
            context.credentials.client_secret.set
              ? "Enter a new value to replace"
              : "Xero app client secret"
          }
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          disabled={!canWrite || saving}
        />
      </div>

      {/* Live regions stay PERMANENTLY mounted and only their content swaps, so
          the message is announced when it appears (a region injected already
          populated is dropped by some SR/browser pairings — AGENTS.md live-region
          rule / PolicyFeedback convention). The styled box exists only when there
          is a message, so the empty region takes no visible space. */}
      <div role="alert">
        {error ? (
          <div className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11">
            {error}
          </div>
        ) : null}
      </div>
      <div role="status">
        {success ? (
          <div className="rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm text-success-11">
            {success}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canWrite || !dirty || saving}
        >
          {saving
            ? "Saving…"
            : bothSet
              ? "Replace credentials"
              : "Save credentials"}
        </Button>
        {bothSet ? (
          <span className="inline-flex items-center gap-1 text-sm text-success-11">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Both credentials stored
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Step 3 — "Connect": OAuth flow + connected-organisation confirmation. */
export function ConnectStep({
  context,
  helpers,
}: {
  context: XeroWizardContext;
  helpers: WizardStepHelpers;
}) {
  const { status, handleDisconnect } = useXeroConnection();

  // On return from the OAuth round-trip (?connected=true), re-derive the wizard
  // context so gating + the org name update.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "true") {
      helpers.refresh();
    }
    // Only on mount — the connect redirect is a full navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onConnect = () => {
    window.location.href = `/api/admin/xero/connect?return=${encodeURIComponent(
      CONNECT_RETURN,
    )}`;
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Connect to Xero
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Authorise the app with Xero. You will be sent to Xero to choose the
          organisation, then returned here.
        </p>
      </div>

      <ConnectionStatusPanel
        status={status}
        onConnect={onConnect}
        onDisconnect={handleDisconnect}
        // Connect / reconnect / disconnect mutate the finance integration, so
        // gate them on finance edit access. The wizard shell renders the
        // view-only banner above (same finance scope), so the disabled controls
        // are explained without a per-button reason.
        canEdit={helpers.canEdit}
      />

      {context.connected ? (
        <div className="flex items-start gap-2 rounded-md border border-success-6 bg-success-3 p-3 text-sm text-success-11">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {context.orgName ? (
              <>
                Connected to <strong>{context.orgName}</strong>. Check this is the
                right Xero organisation — if not, disconnect above and reconnect,
                choosing the correct one.
              </>
            ) : (
              <>
                Connected to Xero. Confirming the organisation name…
              </>
            )}
          </span>
        </div>
      ) : null}
    </div>
  );
}
