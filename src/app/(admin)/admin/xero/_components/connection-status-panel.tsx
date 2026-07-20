"use client"

import { useState } from "react"
import { AlertTriangle, CheckCircle2, Circle, Loader2, XCircle } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { SemanticTone } from "@/lib/chip-tones"
import type { LucideIcon } from "lucide-react"
import { ToneChip } from "./shared"
import type { XeroConnectionProbe, XeroStatus, XeroTokenHealth } from "./types"

// Presentation for each probed health state. reconnect_required / rate_limited
// are warnings (actionable), error is a hard failure.
const HEALTH_PRESENTATION: Record<
  XeroTokenHealth,
  { tone: SemanticTone; icon: LucideIcon; label: string; showReconnect: boolean }
> = {
  ok: { tone: "success", icon: CheckCircle2, label: "Connection healthy", showReconnect: false },
  reconnect_required: {
    tone: "warning",
    icon: AlertTriangle,
    label: "Reconnect required",
    showReconnect: true,
  },
  rate_limited: {
    tone: "warning",
    icon: AlertTriangle,
    label: "Xero daily limit reached",
    showReconnect: false,
  },
  error: { tone: "danger", icon: XCircle, label: "Connection check failed", showReconnect: false },
}

export function ConnectionStatusPanel({
  status,
  onConnect,
  onDisconnect,
}: {
  status: XeroStatus | null
  onConnect: () => void
  onDisconnect: () => void
}) {
  const { confirm, confirmDialog } = useConfirm()
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<XeroConnectionProbe | null>(null)
  const [probeError, setProbeError] = useState(false)

  // Click-only (#2105): the live probe never runs on mount or a poll — only
  // when the admin presses "Check connection".
  async function handleCheckConnection() {
    setProbing(true)
    setProbeError(false)
    try {
      const res = await fetch("/api/admin/xero/status?probe=1")
      if (!res.ok) throw new Error("probe failed")
      const data = await res.json()
      setProbe((data.probe as XeroConnectionProbe) ?? null)
    } catch {
      setProbe(null)
      setProbeError(true)
    } finally {
      setProbing(false)
    }
  }

  const presentation = probe ? HEALTH_PRESENTATION[probe.tokenHealth] : null

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          Connection Status
          {status?.connected ? (
            <ToneChip tone="success" icon={CheckCircle2}>
              Connected
            </ToneChip>
          ) : (
            <ToneChip tone="neutral" icon={Circle}>
              Not Connected
            </ToneChip>
          )}
        </CardTitle>
        <CardDescription>
          {status?.connected
            ? "Xero is connected for operational syncs. Finance report scope readiness is verified by finance sync diagnostics; reconnect Xero if report syncs fail with missing-scope guidance."
            : "Connect your Xero organisation to enable accounting integration."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status?.connected ? (
          <div className="space-y-3">
            <div className="text-sm">
              <span className="text-muted-foreground">Tenant ID:</span>{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{status.tenantId}</code>
            </div>
            {status.tokenExpiresAt ? (
              <div className="text-sm">
                <span className="text-muted-foreground">Token expires:</span>{" "}
                {new Date(status.tokenExpiresAt).toLocaleString("en-NZ")}
                <span className="ml-1 text-muted-foreground">(auto-refreshes)</span>
              </div>
            ) : null}

            {/* Live connection-health check. The green "Connected" chip above
                reflects token-row presence only; this button actually exercises
                the refresh + a cheap org read (#2105). */}
            <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCheckConnection}
                  disabled={probing}
                >
                  {probing ? (
                    <>
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                      Checking…
                    </>
                  ) : (
                    "Check connection"
                  )}
                </Button>
                {presentation ? (
                  <ToneChip tone={presentation.tone} icon={presentation.icon}>
                    {presentation.label}
                  </ToneChip>
                ) : null}
                {presentation?.showReconnect ? (
                  <Button type="button" size="sm" onClick={onConnect}>
                    Reconnect
                  </Button>
                ) : null}
              </div>
              {probeError ? (
                <p className="text-xs text-red-700">
                  Couldn&apos;t check the connection. Please try again.
                </p>
              ) : null}
              {probe?.lastErrorMessage ? (
                <p className="text-xs text-muted-foreground">
                  Most recent Xero error:{" "}
                  <code className="rounded bg-muted px-1 py-0.5">{probe.lastErrorMessage}</code>
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Verifies the Xero token can still be refreshed. Runs only when you press the button.
              </p>
            </div>

            {confirmDialog}
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                if (
                  await confirm({
                    title: "Disconnect Xero?",
                    description:
                      "Invoicing, payment reconciliation, subscription (paid-status) detection, and finance syncs that rely on Xero will stop until you reconnect. Your data inside Xero is not changed.",
                    confirmLabel: "Disconnect",
                    destructive: true,
                  })
                ) {
                  onDisconnect()
                }
              }}
            >
              Disconnect Xero
            </Button>
            <p className="text-xs text-muted-foreground">
              Disconnecting stops invoicing, reconciliation, subscription detection,
              and finance syncs until you reconnect. It does not change anything
              inside Xero.
            </p>
          </div>
        ) : (
          <Button onClick={onConnect}>Connect Xero</Button>
        )}
      </CardContent>
    </Card>
  )
}
