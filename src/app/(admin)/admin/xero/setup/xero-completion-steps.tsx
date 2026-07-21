"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyField } from "@/components/admin/integration-wizard";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";
import { useClubIdentity } from "@/components/club-identity-provider";
import { MappingsPanel } from "../_components/mappings-panel";
import { SetupPanels } from "../_components/setup-panels";
import type { SyncResult } from "../_components/types";
import type { XeroWizardContext } from "./use-xero-wizard-context";

const CREDENTIALS_ENDPOINT = "/api/admin/integrations/credentials";
const WEBHOOK_STATUS_ENDPOINT = "/api/admin/xero/webhook/verify-status";

// Client-side mirror of the server verify contract (see
// src/lib/xero-webhook-validation.ts). Kept as local literals so the client
// bundle never imports the server-only (prisma-backed) module. 30 x 3s = 90s,
// comfortably past C1's 45s credential-cache TTL so a genuine intent-to-receive
// ping delivered to a cold web slot / the cron-leader still lands green.
const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS = 30;

interface WebhookVerifyStatus {
  webhookKeyConfigured?: boolean;
  verified?: boolean;
  freshVerified?: boolean;
  serverNow?: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Step 4 — Webhooks (OPTIONAL / skippable, epic decision 5).
 *
 * Show the delivery URL, capture Xero's "Webhooks key" (Full Admin only, via the
 * C1 credentials API), then Verify by polling for a freshness-scoped
 * intent-to-receive marker. Skip leaves the persistent amber badge. A
 * localhost/non-public-HTTPS deployment can't receive the ping, so it explains
 * why and offers only Skip.
 */
export function WebhooksStep({
  context,
  helpers,
}: {
  context: XeroWizardContext;
  helpers: WizardStepHelpers;
}) {
  const canWrite = context.isFullAdmin;
  const keySet = context.credentials.webhook_key.set;

  const [webhookKey, setWebhookKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const cancelledRef = useRef(false);

  const saveKey = useCallback(async () => {
    const value = webhookKey.trim();
    if (!value) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(CREDENTIALS_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "xero", key: "webhook_key", value }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error || "Failed to save the webhook key.");
      }
      setWebhookKey("");
      setNotice(
        "Webhook key saved. In Xero, save the webhook so Xero sends its verification, then Verify below.",
      );
      helpers.refresh();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save.",
      );
    } finally {
      setSaving(false);
    }
  }, [helpers, webhookKey]);

  const verify = useCallback(async () => {
    setVerifying(true);
    setError("");
    setNotice("");
    cancelledRef.current = false;
    try {
      // Anchor verify-start to the SERVER clock (not the browser's): the first
      // status read returns serverNow, then every poll requires a marker newer
      // than that instant AND matching the current key.
      const startRes = await fetch(WEBHOOK_STATUS_ENDPOINT, {
        credentials: "same-origin",
      });
      if (!startRes.ok) throw new Error("Could not start verification.");
      const start = (await startRes.json()) as WebhookVerifyStatus;
      const since = start.serverNow ?? Date.now();

      for (let i = 0; i < MAX_POLLS; i += 1) {
        if (cancelledRef.current) return;
        await delay(POLL_INTERVAL_MS);
        if (cancelledRef.current) return;
        const res = await fetch(
          `${WEBHOOK_STATUS_ENDPOINT}?since=${encodeURIComponent(String(since))}`,
          { credentials: "same-origin" },
        );
        if (!res.ok) continue;
        const data = (await res.json()) as WebhookVerifyStatus;
        if (data.freshVerified) {
          setNotice("Webhooks verified — payment updates arrive in real time.");
          helpers.refresh();
          return;
        }
      }
      setError(
        "No verification ping received yet. In Xero, open your webhook and use Save/Send to trigger the intent-to-receive check, then Verify again. You can also Skip for now and finish this later.",
      );
    } catch (verifyError) {
      setError(
        verifyError instanceof Error
          ? verifyError.message
          : "Verification failed.",
      );
    } finally {
      setVerifying(false);
    }
  }, [helpers]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Webhooks (optional)
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Webhooks let Xero tell the app the moment an invoice is paid or a
          contact changes, so payment status updates in real time. Without them
          the scheduled sync still catches everything up on its next run — so you
          can Skip this now and finish it later.
        </p>
      </div>

      {context.webhookVerified ? (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Webhooks are verified. Xero&rsquo;s validation ping reached this site
            and matched the stored key — real-time payment updates are on.
          </span>
        </div>
      ) : null}

      {!context.webhooksVerifiable ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Webhooks can&rsquo;t be verified on this address. Xero only delivers
            to a public <strong>https://</strong> site, and this deployment
            resolves to a local or non-HTTPS URL
            {context.companyUrl ? (
              <>
                {" "}
                (<code className="rounded bg-amber-100 px-1">{context.companyUrl}</code>)
              </>
            ) : null}
            . Skip for now; once the site is reachable over public HTTPS, return
            here to add and verify the webhook. The scheduled sync keeps payments
            up to date in the meantime.
          </span>
        </div>
      ) : (
        <>
          <CopyField
            label="Webhook delivery URL"
            value={
              context.webhookDeliveryUrl ||
              "Set NEXTAUTH_URL so the delivery URL can be derived"
            }
            description="In Xero (My Apps → your app → Webhooks), paste this as the delivery URL, then subscribe to the Invoices and Contacts events."
          />

          {!canWrite ? (
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                Only a <strong>Full Admin</strong> can enter or replace the Xero
                webhook key. You can view the status here.
              </span>
            </div>
          ) : null}

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="xero-wizard-webhook-key">
                Webhooks key (from Xero)
              </Label>
              <span className="text-xs">
                {keySet ? (
                  <span className="text-emerald-700">Set &#10003;</span>
                ) : (
                  <span className="text-muted-foreground">Not set</span>
                )}
              </span>
            </div>
            <Input
              id="xero-wizard-webhook-key"
              type="password"
              autoComplete="off"
              placeholder={
                keySet ? "Enter a new value to replace" : "Xero webhooks key"
              }
              value={webhookKey}
              onChange={(e) => setWebhookKey(e.target.value)}
              disabled={!canWrite || saving || verifying}
            />
            <p className="text-xs text-muted-foreground">
              Xero shows this key when you save the webhook. It is encrypted at
              rest and never shown again. Replacing it re-arms verification.
            </p>
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {error}
            </div>
          ) : null}
          {notice ? (
            <div
              role="status"
              className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
            >
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{notice}</span>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => void saveKey()}
              disabled={!canWrite || !webhookKey.trim() || saving || verifying}
            >
              {saving ? "Saving…" : keySet ? "Replace key" : "Save key"}
            </Button>
            <Button
              type="button"
              onClick={() => void verify()}
              disabled={!keySet || verifying || saving}
            >
              {verifying ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
                  Waiting for Xero…
                </>
              ) : (
                "Verify"
              )}
            </Button>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">
          {context.webhookVerified
            ? "Verified. Continue to account mapping."
            : "Not required to finish setup — Skip keeps an amber reminder until you verify."}
        </p>
        {!context.webhookVerified ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => helpers.acknowledge()}
            disabled={verifying}
          >
            Skip for now
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Step 5 — Account mapping. Embeds the existing MappingsPanel unchanged (not
 * forked) with a plain-English intro; the panel already shows each mapping's
 * description and falls back to sensible defaults where a mapping is left
 * unset ("Not configured (using default)").
 */
export function MappingStep({ context }: { context: XeroWizardContext }) {
  const club = useClubIdentity();
  const noop = useCallback(() => {}, []);
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Map accounts &amp; items
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose which Xero accounts and item codes booking transactions post to.
          Anything you leave unset uses a sensible default, so you can map only
          what your chart of accounts needs and refine the rest later. Each row
          below explains what it controls.
        </p>
      </div>
      {context.connected ? (
        <MappingsPanel
          connected={context.connected}
          open
          onToggle={noop}
          clubName={club.name}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Connect Xero first to load your chart of accounts.
        </p>
      )}
    </div>
  );
}

/**
 * Step 6 — Import & finish. The one-time contact import/link tools (existing
 * SetupPanels, embedded not forked) plus a finish summary covering the connected
 * org, webhook state, and the link to day-to-day /admin/xero.
 */
export function FinishStep({ context }: { context: XeroWizardContext }) {
  const club = useClubIdentity();
  const noop = useCallback(() => {}, []);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [, setSyncResult] = useState<SyncResult | null>(null);
  const [message, setMessage] = useState("");

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Import contacts &amp; finish
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Optionally import your existing Xero contacts as members now (a one-time
          step you can also run later), then you&rsquo;re done.
        </p>
      </div>

      {message ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {message}
        </div>
      ) : null}

      {context.connected ? (
        <SetupPanels
          connected={context.connected}
          open
          onToggle={noop}
          clubName={club.name}
          bookingsName={club.bookingsName}
          syncing={syncing}
          setSyncing={setSyncing}
          setSyncResult={setSyncResult}
          onMessage={setMessage}
          onRefreshOperations={noop}
          onRefreshDiagnostics={noop}
        />
      ) : null}

      <div className="rounded-md border border-border bg-card p-4">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
          Setup summary
        </h4>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-muted-foreground">Organisation</dt>
            <dd className="font-medium text-foreground">
              {context.orgName ?? (context.connected ? "Connected" : "Not connected")}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-muted-foreground">Webhooks</dt>
            <dd>
              {context.webhookVerified ? (
                <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                  Verified
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 font-medium text-amber-700">
                  <AlertTriangle className="h-4 w-4" aria-hidden />
                  Not configured — scheduled sync only
                </span>
              )}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-sm text-muted-foreground">
          Day-to-day syncing, operations, mappings and usage live on the{" "}
          <Link
            href="/admin/xero"
            className="font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
          >
            Xero Sync
          </Link>{" "}
          page. You can return to this wizard any time to add webhooks or change
          mappings.
        </p>
      </div>
    </div>
  );
}
