"use client"

import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { XeroStatus } from "./types"

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

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          Connection Status
          {status?.connected ? (
            <Badge variant="default" className="bg-green-600">
              Connected
            </Badge>
          ) : (
            <Badge variant="secondary">Not Connected</Badge>
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
