"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { BackLink } from "@/components/admin/back-link"
import { useClubIdentity } from "@/components/club-identity-provider"
import { buildPathWithSearch } from "@/lib/internal-return-path"
import {
  ConnectionStatusPanel,
  MappingsPanel,
  SetupPanels,
  SyncResultsPanel,
} from "../_components/panels"
import { Message } from "../_components/message"
import {
  SECTION_DEFAULTS,
  type SectionKey,
  type SyncResult,
} from "../_components/types"
import { useXeroConnection } from "../_hooks/use-xero-connection"

export default function XeroSetupPage() {
  const club = useClubIdentity()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const currentXeroPath = buildPathWithSearch(pathname, searchParams.toString())
  const {
    status,
    loading,
    error,
    setError,
    connectSuccess,
    setConnectSuccess,
    sectionOpen,
    setSectionState,
    handleConnect,
    handleDisconnect,
  } = useXeroConnection()
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [operationMessage, setOperationMessage] = useState("")

  const connected = status?.connected === true
  const noop = () => {}

  useEffect(() => {
    const section = searchParams.get("section")
    if (section && section in SECTION_DEFAULTS) {
      setSectionState(section as SectionKey, true)
    }
  }, [searchParams, setSectionState])

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="mb-4 text-2xl font-bold">Xero Setup</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

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
          className="font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
        >
          Xero Sync
        </Link>{" "}
        page.
      </p>

      {error && <Message tone="error" message={error} onDismiss={() => setError("")} />}
      {operationMessage && <Message tone="success" message={operationMessage} onDismiss={() => setOperationMessage("")} />}
      {connectSuccess && <Message tone="success" message="Xero connected successfully!" onDismiss={() => setConnectSuccess(false)} />}

      <ConnectionStatusPanel status={status} onConnect={handleConnect} onDisconnect={handleDisconnect} />

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
