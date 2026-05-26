"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { redactSensitiveText } from "@/lib/redact-sensitive-json"
import { fetchJson, postJson } from "./api"
import {
  failureStateBadgeClass,
  failureStateLabel,
  FilterSelect,
  formatJson,
  operationStatusClass,
  SectionCard,
  shortId,
  type ToggleSection,
} from "./shared"
import type { XeroOperation } from "./types"

export function OperationsPanel({
  connected,
  open,
  onToggle,
  onMessage,
  onRefreshDiagnostics,
  refreshToken,
}: {
  connected: boolean
  open: boolean
  onToggle: ToggleSection
  onMessage: (message: string) => void
  onRefreshDiagnostics: () => void
  refreshToken: number
}) {
  const [operations, setOperations] = useState<XeroOperation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [entityFilter, setEntityFilter] = useState("all")
  const [retryingOperationId, setRetryingOperationId] = useState<string | null>(null)
  const [markingNonReplayableOperationId, setMarkingNonReplayableOperationId] = useState<string | null>(null)
  const [retryingAllFailed, setRetryingAllFailed] = useState(false)

  const fetchOperations = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        entityType: entityFilter,
        direction: "all",
        limit: "25",
      })
      const data = await fetchJson<{ data?: XeroOperation[] }>(`/api/admin/xero/operations?${params.toString()}`, undefined, "Failed to fetch Xero operations")
      setOperations(data.data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Xero operation history")
    } finally {
      setLoading(false)
    }
  }, [entityFilter, statusFilter])

  useEffect(() => {
    if (connected && open) void fetchOperations()
  }, [connected, fetchOperations, open])

  useEffect(() => {
    if (connected && open && refreshToken !== 0) void fetchOperations()
  }, [connected, fetchOperations, open, refreshToken])

  const retryOperation = async (operationId: string) => {
    setRetryingOperationId(operationId)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>(`/api/admin/xero/operations/${operationId}/retry`, undefined, "Failed to retry Xero operation")
      onMessage(data.message || "Xero operation queued for background retry.")
      await fetchOperations()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry Xero operation")
    } finally {
      setRetryingOperationId(null)
    }
  }

  const markNonReplayable = async (operationId: string) => {
    const reason = window.prompt("Why is this Xero operation not safe to replay?", "Reviewed from Xero operations dashboard")
    if (reason === null) return
    setMarkingNonReplayableOperationId(operationId)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>(
        `/api/admin/xero/operations/${operationId}/mark-non-replayable`,
        { reason },
        "Failed to mark Xero operation non-replayable"
      )
      onMessage(data.message || "Xero operation marked non-replayable.")
      await fetchOperations()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark Xero operation non-replayable")
    } finally {
      setMarkingNonReplayableOperationId(null)
    }
  }

  const retryAllFailed = async () => {
    setRetryingAllFailed(true)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>("/api/admin/xero/operations/retry-all", undefined, "Failed to queue failed Xero operations")
      onMessage(data.message || "Queued failed Xero operations for retry.")
      await fetchOperations()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue failed Xero operations")
    } finally {
      setRetryingAllFailed(false)
    }
  }

  return (
    <SectionCard
      id="xero-section-operations"
      title="Xero Operations"
      description="Recent outbound sync attempts and replayable failures."
      open={open}
      onToggle={(nextOpen) => onToggle("operations", nextOpen)}
      actions={
        <>
          <Button size="sm" onClick={() => void retryAllFailed()} disabled={retryingAllFailed}>
            {retryingAllFailed ? "Queueing..." : "Retry Active Failed"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void fetchOperations()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <FilterSelect label="Status" value={statusFilter} onValueChange={setStatusFilter} values={["all", "FAILED", "PENDING", "PARTIAL", "RUNNING", "SUCCEEDED"]} />
          <FilterSelect label="Entity" value={entityFilter} onValueChange={setEntityFilter} values={["all", "CONTACT", "CONTACT_GROUP", "INVOICE", "PAYMENT", "CREDIT_NOTE", "ALLOCATION", "SUBSCRIPTION"]} />
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading recent operations...</p>
        ) : operations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Xero operations recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {operations.map((operation) => (
              <OperationItem
                key={operation.id}
                operation={operation}
                retrying={retryingOperationId === operation.id}
                markingNonReplayable={markingNonReplayableOperationId === operation.id}
                onRetry={() => void retryOperation(operation.id)}
                onMarkNonReplayable={() => void markNonReplayable(operation.id)}
              />
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  )
}

function OperationItem({
  operation,
  retrying,
  markingNonReplayable,
  onRetry,
  onMarkNonReplayable,
}: {
  operation: XeroOperation
  retrying: boolean
  markingNonReplayable: boolean
  onRetry: () => void
  onMarkNonReplayable: () => void
}) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default" className={operationStatusClass(operation.status)}>{operation.status}</Badge>
        {operation.failureState ? <Badge variant="default" className={failureStateBadgeClass(operation.failureState)}>{failureStateLabel(operation.failureState)}</Badge> : null}
        <span className="text-sm font-medium">{operation.entityType} {operation.operationType}</span>
        <span className="text-xs text-muted-foreground">{new Date(operation.createdAt).toLocaleString("en-NZ")}</span>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>Direction: {operation.direction}</span>
        <span>Attempt: {operation.attemptCount}</span>
        {operation.localModel ? (
          <span>
            Local:{" "}
            {operation.localUrl ? (
              <a href={operation.localUrl} className="text-blue-600 hover:underline">{operation.localModel} {shortId(operation.localId)}</a>
            ) : (
              `${operation.localModel} ${shortId(operation.localId)}`
            )}
          </span>
        ) : null}
        {operation.xeroObjectId ? (
          <span>
            Xero:{" "}
            {operation.xeroObjectUrl ? (
              <a href={operation.xeroObjectUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                {operation.xeroObjectNumber || shortId(operation.xeroObjectId)}
              </a>
            ) : (
              operation.xeroObjectNumber || shortId(operation.xeroObjectId)
            )}
          </span>
        ) : null}
      </div>
      {operation.lastErrorMessage ? (
        <p className="text-sm text-red-700">
          {operation.lastErrorCode ? `${operation.lastErrorCode}: ` : ""}
          {redactSensitiveText(operation.lastErrorMessage)}
        </p>
      ) : null}
      {operation.failureStateReason && operation.status === "FAILED" ? <p className="text-xs text-muted-foreground">{operation.failureStateReason}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {operation.supported && operation.failureState !== "REPAIRED" && operation.failureState !== "SUPERSEDED" ? (
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? "Queueing..." : "Retry in background"}
          </Button>
        ) : operation.reason && (operation.status === "FAILED" || operation.status === "PARTIAL") ? (
          <p className="text-xs text-muted-foreground">{operation.reason}</p>
        ) : null}
        {operation.replayable && (operation.status === "FAILED" || operation.status === "PARTIAL") ? (
          <Button variant="outline" size="sm" onClick={onMarkNonReplayable} disabled={markingNonReplayable}>
            {markingNonReplayable ? "Archiving..." : "Mark non-replayable"}
          </Button>
        ) : null}
      </div>
      <details className="rounded-md bg-slate-50 p-2">
        <summary className="cursor-pointer text-xs font-medium text-slate-700">View request / response payloads</summary>
        <div className="mt-2 grid gap-3 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-slate-700">Request</p>
            <pre className="max-h-64 overflow-auto rounded border bg-white p-2 text-[11px]">{formatJson(operation.requestPayload)}</pre>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-slate-700">Response</p>
            <pre className="max-h-64 overflow-auto rounded border bg-white p-2 text-[11px]">{formatJson(operation.responsePayload)}</pre>
          </div>
        </div>
      </details>
    </div>
  )
}
