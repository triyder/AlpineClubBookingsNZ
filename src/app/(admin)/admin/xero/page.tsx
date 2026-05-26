"use client"

import { useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { useClubIdentity } from "@/components/club-identity-provider"
import { buildPathWithSearch } from "@/lib/internal-return-path"
import {
  ConnectionStatusPanel,
  ContactSyncPanel,
  HealthAndDiagnosticsPanels,
  InboundEventsPanel,
  MappingsPanel,
  MembershipSyncPanel,
  OperationsPanel,
  SetupPanels,
  SyncResultsPanel,
  UsagePanel,
} from "./_components/panels"
import type { SyncResult } from "./_components/types"
import { useXeroConnection } from "./_hooks/use-xero-connection"

export default function XeroPage() {
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
    scrollToSection,
    handleConnect,
    handleDisconnect,
  } = useXeroConnection()
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [operationMessage, setOperationMessage] = useState("")
  const [diagnosticsRefreshToken, setDiagnosticsRefreshToken] = useState(0)
  const [operationsRefreshToken, setOperationsRefreshToken] = useState(0)
  const [usageRefreshToken, setUsageRefreshToken] = useState(0)

  const connected = status?.connected === true
  const refreshDiagnostics = () => setDiagnosticsRefreshToken((value) => value + 1)
  const refreshOperations = () => setOperationsRefreshToken((value) => value + 1)
  const publishMessage = (message: string) => {
    setOperationMessage(message)
    if (message) setUsageRefreshToken((value) => value + 1)
  }

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="mb-4 text-2xl font-bold">Xero Integration</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  return (
    <div className="max-w-6xl p-6">
      <h1 className="mb-2 text-2xl font-bold">Xero Integration</h1>
      <p className="mb-6 text-muted-foreground">
        Connect to Xero for automatic invoice creation, membership verification, and contact sync.
      </p>

      {error && <Message tone="error" message={error} onDismiss={() => setError("")} />}
      {operationMessage && <Message tone="success" message={operationMessage} onDismiss={() => setOperationMessage("")} />}
      {connectSuccess && <Message tone="success" message="Xero connected successfully!" onDismiss={() => setConnectSuccess(false)} />}

      <ConnectionStatusPanel status={status} onConnect={handleConnect} onDisconnect={handleDisconnect} />

      {connected && (
        <>
          <HealthAndDiagnosticsPanels
            connected={connected}
            currentXeroPath={currentXeroPath}
            healthOpen={sectionOpen.health}
            contactGroupMismatchesOpen={sectionOpen.contactGroupMismatches}
            contactLinkMismatchesOpen={sectionOpen.contactLinkMismatches}
            onToggle={setSectionState}
            onMessage={publishMessage}
            onRefreshOperations={refreshOperations}
            refreshToken={diagnosticsRefreshToken}
            scrollToSection={scrollToSection}
          />
          <OperationsPanel
            connected={connected}
            open={sectionOpen.operations}
            onToggle={setSectionState}
            onMessage={publishMessage}
            onRefreshDiagnostics={refreshDiagnostics}
            refreshToken={operationsRefreshToken}
          />
          <InboundEventsPanel
            connected={connected}
            open={sectionOpen.inbound}
            onToggle={setSectionState}
            onMessage={publishMessage}
            onRefreshOperations={refreshOperations}
            onRefreshDiagnostics={refreshDiagnostics}
            refreshToken={0}
          />
          <ContactSyncPanel
            connected={connected}
            open={sectionOpen.contactSync}
            onToggle={setSectionState}
            clubName={club.name}
            syncing={syncing}
            setSyncing={setSyncing}
            setSyncResult={setSyncResult}
            onMessage={publishMessage}
            onRefreshOperations={refreshOperations}
            onRefreshDiagnostics={refreshDiagnostics}
          />
          <MembershipSyncPanel
            connected={connected}
            open={sectionOpen.membershipSync}
            onToggle={setSectionState}
            syncing={syncing}
            setSyncing={setSyncing}
            setSyncResult={setSyncResult}
            onRefreshDiagnostics={refreshDiagnostics}
            refreshToken={diagnosticsRefreshToken}
          />
          <SyncResultsPanel syncResult={syncResult} currentXeroPath={currentXeroPath} />
          <UsagePanel connected={connected} open={sectionOpen.usage} onToggle={setSectionState} refreshToken={usageRefreshToken} />
          <MappingsPanel connected={connected} open={sectionOpen.mappings} onToggle={setSectionState} clubName={club.name} />
          <SetupPanels
            connected={connected}
            open={sectionOpen.setup}
            onToggle={setSectionState}
            clubName={club.name}
            bookingsName={club.bookingsName}
            syncing={syncing}
            setSyncing={setSyncing}
            setSyncResult={setSyncResult}
            onMessage={publishMessage}
            onRefreshOperations={refreshOperations}
            onRefreshDiagnostics={refreshDiagnostics}
          />
        </>
      )}
    </div>
  )
}

function Message({ tone, message, onDismiss }: { tone: "error" | "success"; message: string; onDismiss: () => void }) {
  const className =
    tone === "error"
      ? "mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
      : "mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700"
  return (
    <div className={className}>
      {message}
      <button onClick={onDismiss} className="ml-2 underline">
        Dismiss
      </button>
    </div>
  )
}
