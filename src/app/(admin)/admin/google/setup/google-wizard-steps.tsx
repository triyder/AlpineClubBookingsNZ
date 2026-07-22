"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "next-auth/react";
import { CopyField } from "@/components/admin/integration-wizard";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";
import type {
  GoogleCredentialKey,
  GoogleWizardContext,
} from "./use-google-wizard-context";

const CREDENTIALS_ENDPOINT = "/api/admin/integrations/credentials";
const VERIFY_START_ENDPOINT = "/api/admin/integrations/google/verify/start";

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
    <Alert variant="warning" title="Legacy environment variables ignored">
      These legacy environment variables are no longer used and are ignored:{" "}
      <code className="rounded bg-warning-muted px-1">{vars.join(", ")}</code>.
      Enter the credentials in-app here, then remove them from the environment.
    </Alert>
  );
}

function SetStatus({ set, setAt }: { set: boolean; setAt: string | null }) {
  return (
    <span className="text-xs">
      {set ? (
        <span className="text-success">Set ✓ {formatSetAt(setAt)}</span>
      ) : (
        <span className="text-muted-foreground">Not set</span>
      )}
    </span>
  );
}

async function writeCredential(
  key: GoogleCredentialKey,
  value: string,
): Promise<void> {
  const res = await fetch(CREDENTIALS_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "google", key, value }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(data?.error || `Failed to save ${key}.`);
  }
}

/** Step 1 — "Create your OAuth client": portal-mirroring instructions + redirect URI. */
export function PortalGuideStep({ context }: { context: GoogleWizardContext }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Create a Google OAuth client
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          In a new tab, open the{" "}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
          >
            Google Cloud Console credentials page
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
          . Create (or reuse) a project, then choose{" "}
          <strong>Create credentials → OAuth client ID</strong> and pick{" "}
          <strong>Web application</strong>.
        </p>
      </div>

      <LegacyEnvWarning vars={context.legacyEnvVars} />

      <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">
          Two fields need exact values
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <strong>Authorized redirect URI</strong> — paste the value below
            exactly. Google will only redirect back to a URI it has on file, so
            a mismatch is the most common cause of a failed sign-in.
          </li>
          <li>
            <strong>Authorized JavaScript origins</strong> (if asked) — your
            site&apos;s origin, e.g. the part of the URI before{" "}
            <code>/api/…</code>.
          </li>
        </ul>
      </div>

      <CopyField
        label="Authorized redirect URI"
        value={context.redirectUri}
        emptyHint="Set NEXTAUTH_URL so the redirect URI can be derived."
        description="Paste this into the OAuth client's Authorized redirect URIs field."
      />

      <p className="text-sm text-muted-foreground">
        When Google shows your <strong>Client ID</strong> and{" "}
        <strong>Client secret</strong>, keep the tab open and continue to the
        next step to enter them here.
      </p>
    </div>
  );
}

/** Step 2 — "Enter credentials": write-only client id + secret → C1 API. */
export function CredentialsStep({
  context,
  helpers,
}: {
  context: GoogleWizardContext;
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

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      // Write only the fields the operator actually filled in (Replace flow).
      if (clientId.trim()) await writeCredential("client_id", clientId.trim());
      if (clientSecret.trim())
        await writeCredential("client_secret", clientSecret.trim());
      setClientId("");
      setClientSecret("");
      setSuccess(
        "Credentials saved. Any previous verification was reset — verify on the next step.",
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
        <h3 className="text-base font-semibold text-foreground">
          Enter your Google OAuth credentials
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste the Client ID and Client secret from the Google Cloud Console.
          Both are encrypted at rest and never shown again; entering a new value
          replaces the old one and re-locks Google sign-in until you verify
          again.
        </p>
      </div>

      <LegacyEnvWarning vars={context.legacyEnvVars} />

      {context.needsReentry ? (
        <Alert variant="warning" title="Stored credentials can no longer be read">
          A stored Google credential can no longer be decrypted (the app
          encryption key changed). Re-enter both values below to restore Google
          sign-in.
        </Alert>
      ) : null}

      {!canWrite ? (
        <Alert variant="warning">
          Only a <strong>Full Admin</strong> can enter or replace Google
          credentials. You can view the status here.
        </Alert>
      ) : null}

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="google-wizard-client-id">Client ID</Label>
          <SetStatus
            set={context.credentials.client_id.set}
            setAt={context.credentials.client_id.setAt}
          />
        </div>
        <Input
          id="google-wizard-client-id"
          type="text"
          autoComplete="off"
          placeholder={
            context.credentials.client_id.set
              ? "Enter a new value to replace"
              : "123456789-abc.apps.googleusercontent.com"
          }
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          disabled={!canWrite || saving}
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="google-wizard-client-secret">Client secret</Label>
          <SetStatus
            set={context.credentials.client_secret.set}
            setAt={context.credentials.client_secret.setAt}
          />
        </div>
        <Input
          id="google-wizard-client-secret"
          type="password"
          autoComplete="off"
          placeholder={
            context.credentials.client_secret.set
              ? "Enter a new value to replace"
              : "GOCSPX-…"
          }
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          disabled={!canWrite || saving}
        />
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}
      {success ? <Alert variant="success">{success}</Alert> : null}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canWrite || !dirty || saving}
        >
          {saving ? "Saving…" : bothSet ? "Replace credentials" : "Save credentials"}
        </Button>
        {bothSet ? (
          <span className="text-sm text-success">Both credentials stored</span>
        ) : null}
      </div>
    </div>
  );
}

/** Step 3 — "Verify": a real OAuth round-trip through the production callback. */
export function VerifyStep({
  context,
  helpers,
}: {
  context: GoogleWizardContext;
  helpers: WizardStepHelpers;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  // On a session-mismatch verify failure the signIn callback redirects back
  // here with `?googleVerifyError=1` (src/lib/auth.ts). Without this the
  // operator would land on the verify step with no sign anything went wrong.
  // Success needs no param handling: the callback records verification, so the
  // freshly-loaded context reports `verified` and the green Alert below shows.
  const searchParams = useSearchParams();
  const verifyFailed =
    searchParams?.get("googleVerifyError") === "1" && !context.verified;

  const canVerify =
    context.isFullAdmin &&
    context.credentials.client_id.set &&
    context.credentials.client_secret.set &&
    !context.needsReentry;

  async function startVerify() {
    setStarting(true);
    setError("");
    try {
      const res = await fetch(VERIFY_START_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(data?.error || "Could not start verification. Try again.");
        setStarting(false);
        return;
      }
      // Full-page OAuth round-trip through the SAME production callback the
      // redirect URI points at. The verify-intent cookie is set; on return the
      // signIn callback records verification and redirects back here. No session
      // is minted and no account is linked.
      await signIn("google", { callbackUrl: "/admin/google/setup" });
    } catch {
      setError("Could not start verification. Try again.");
      setStarting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Verify Google sign-in
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Click through Google&apos;s consent screen once, as yourself, to prove
          the credentials and redirect URI are correct. This does not link your
          account or sign you in with Google — it only confirms Google accepts
          the client and redirects back. Google sign-in stays locked until this
          passes.
        </p>
      </div>

      {verifyFailed ? (
        <Alert variant="error" title="Verification couldn't be completed">
          Verification couldn&apos;t be completed — make sure you&apos;re signed
          in as the same Full Admin who started it, then try again.
        </Alert>
      ) : null}

      {context.verified ? (
        <Alert variant="success" title="Verified">
          A real Google sign-in round-trip completed successfully. You can now
          turn on Google sign-in on the{" "}
          <Link
            href="/admin/security"
            className="font-medium underline underline-offset-4"
          >
            Login &amp; Security page
          </Link>
          . Members can then link their Google account from their profile.
        </Alert>
      ) : (
        <Alert variant="warning" title="Not verified yet">
          {context.credentials.client_id.set &&
          context.credentials.client_secret.set ? (
            <>
              Run the verification round-trip below. If the Client ID, Client
              secret, or redirect URI is wrong, Google will bounce you to the
              login page with an error instead of returning here — come back to
              this page and retry after fixing them in Google Cloud.
            </>
          ) : (
            "Enter both credentials on the previous step, then verify here."
          )}
        </Alert>
      )}

      {!context.isFullAdmin ? (
        <Alert variant="warning">
          Only a <strong>Full Admin</strong> can run verification.
        </Alert>
      ) : null}

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={() => void startVerify()}
          disabled={!canVerify || starting}
        >
          {starting
            ? "Starting…"
            : context.verified
              ? "Verify again"
              : "Verify with Google"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => helpers.refresh()}
        >
          Re-check status
        </Button>
      </div>
    </div>
  );
}
