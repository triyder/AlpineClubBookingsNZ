"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { BackLink } from "@/components/admin/back-link"
import { useClubIdentity } from "@/components/club-identity-provider"
import { buildPathWithSearch } from "@/lib/internal-return-path"
import { XeroSetupWizard } from "../setup/xero-setup-wizard"
import type { XeroWizardServerConfig } from "../setup/use-xero-wizard-context"
import {
  MappingsPanel,
  SetupPanels,
  SyncResultsPanel,
} from "./panels"
import { Message } from "./message"
import type { SyncResult } from "./types"
import { useXeroConnection } from "../_hooks/use-xero-connection"

/**
 * Xero Setup page body (#2080). The guided wizard is the credential-entry and
 * connect surface (it supersedes C1's interim XeroCredentialsSection and the
 * standalone connection panel). The mapping/import/sync panels below remain for
 * already-connected clubs.
 */
export function XeroSetupPageClient({
  serverConfig,
}: {
  serverConfig: XeroWizardServerConfig
}) {
  const club = useClubIdentity()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const currentXeroPath = buildPathWithSearch(pathname, searchParams.toString())
  const { status, sectionOpen, setSectionState } = useXeroConnection()
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [operationMessage, setOperationMessage] = useState("")

  const connected = status?.connected === true
  const noop = () => {}

  return (
    <div className="max-w-6xl p-6">
      <BackLink href="/admin/integrations" label="Integrations" />
      <h1 className="mt-2 mb-2 text-2xl font-bold">Xero Setup</h1>
      <p className="mb-2 text-muted-foreground">
        Connect Xero, configure account and item mappings, and run one-time contact import and linking.
      </p>
      <p className="mb-6 text-sm">
        Day-to-day syncing, operations, and usage live on the{" "}
        <Link
          href="/admin/xero"
          className="font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
        >
          Xero Sync
        </Link>{" "}
        page.
      </p>

      {operationMessage && <Message tone="success" message={operationMessage} onDismiss={() => setOperationMessage("")} />}

      <div className="mb-6">
        <XeroSetupWizard serverConfig={serverConfig} />
      </div>

      {connected && (
        <>
          <MappingsPanel
            connected={connected}
            open={sectionOpen.mappings}
            onToggle={setSectionState}
            clubName={club.name}
          />
          <SetupPanels
            connected={connected}
            open={sectionOpen.setup}
            onToggle={setSectionState}
            clubName={club.name}
            bookingsName={club.bookingsName}
            syncing={syncing}
            setSyncing={setSyncing}
            setSyncResult={setSyncResult}
            onMessage={setOperationMessage}
            onRefreshOperations={noop}
            onRefreshDiagnostics={noop}
          />
          <SyncResultsPanel syncResult={syncResult} currentXeroPath={currentXeroPath} />
        </>
      )}
    </div>
  )
}
