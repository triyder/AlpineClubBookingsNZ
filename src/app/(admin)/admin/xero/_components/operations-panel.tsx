"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // Hold the latest searchParams in a ref so syncUrl can preserve the *other*
  // panel's params without taking searchParams as a reactive dependency. If it
  // did, the sibling InboundEventsPanel rewriting the URL would re-trigger this
  // panel's sync (and vice versa), causing the section param to ping-pong
  // forever. Keyed off our own filter state only, the loop cannot form.
  const searchParamsRef = useRef(searchParams)
  useEffect(() => {
    searchParamsRef.current = searchParams
  }, [searchParams])
  const hasOperationsUrlState =
    searchParams.get("section") === "operations" ||
    [
      "opStatus",
      "opEntityType",
      "opLocalModel",
      "opLocalId",
      "opOperationType",
      "opFailureState",
      "opResourceId",
      "opCreatedFrom",
      "opCreatedTo",
      "opPage",
    ].some((key) => searchParams.has(key))
  const [operations, setOperations] = useState<XeroOperation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [statusFilter, setStatusFilter] = useState(searchParams.get("opStatus") || "all")
  const [entityFilter, setEntityFilter] = useState(searchParams.get("opEntityType") || "all")
  const [localModelFilter, setLocalModelFilter] = useState(searchParams.get("opLocalModel") || "all")
  const [localIdFilter, setLocalIdFilter] = useState(searchParams.get("opLocalId") || "")
  const [operationTypeFilter, setOperationTypeFilter] = useState(searchParams.get("opOperationType") || "all")
  const [failureStateFilter, setFailureStateFilter] = useState(searchParams.get("opFailureState") || "all")
  const [resourceIdFilter, setResourceIdFilter] = useState(searchParams.get("opResourceId") || "")
  const [createdFrom, setCreatedFrom] = useState(searchParams.get("opCreatedFrom") || "")
  const [createdTo, setCreatedTo] = useState(searchParams.get("opCreatedTo") || "")
  const [page, setPage] = useState(() => {
    const requested = Number(searchParams.get("opPage") || "1")
    return Number.isInteger(requested) && requested > 0 ? requested : 1
  })
  const [total, setTotal] = useState(0)
  const pageSize = 25
  const [urlSyncEnabled, setUrlSyncEnabled] = useState(hasOperationsUrlState)
  const [retryingOperationId, setRetryingOperationId] = useState<string | null>(null)
  const [markingNonReplayableOperationId, setMarkingNonReplayableOperationId] = useState<string | null>(null)
  const [resolvingOperationId, setResolvingOperationId] = useState<string | null>(null)
  const [retryingAllFailed, setRetryingAllFailed] = useState(false)
  const [resettingStale, setResettingStale] = useState(false)

  const syncUrl = useCallback(() => {
    if (!urlSyncEnabled) return

    const currentSearch = searchParamsRef.current.toString()
    const params = new URLSearchParams(currentSearch)
    params.set("section", "operations")

    const setOrDelete = (key: string, value: string, defaultValue = "") => {
      if (value && value !== defaultValue) params.set(key, value)
      else params.delete(key)
    }

    setOrDelete("opStatus", statusFilter, "all")
    setOrDelete("opEntityType", entityFilter, "all")
    setOrDelete("opLocalModel", localModelFilter, "all")
    setOrDelete("opLocalId", localIdFilter)
    setOrDelete("opOperationType", operationTypeFilter, "all")
    setOrDelete("opFailureState", failureStateFilter, "all")
    setOrDelete("opResourceId", resourceIdFilter)
    setOrDelete("opCreatedFrom", createdFrom)
    setOrDelete("opCreatedTo", createdTo)
    setOrDelete("opPage", page > 1 ? String(page) : "")

    const query = params.toString()
    const nextPath = query ? `${pathname}?${query}` : pathname
    const currentPath = currentSearch ? `${pathname}?${currentSearch}` : pathname
    if (nextPath !== currentPath) {
      router.replace(nextPath, { scroll: false })
    }
  }, [
    createdFrom,
    createdTo,
    entityFilter,
    failureStateFilter,
    localIdFilter,
    localModelFilter,
    operationTypeFilter,
    page,
    pathname,
    resourceIdFilter,
    router,
    statusFilter,
    urlSyncEnabled,
  ])

  useEffect(() => {
    syncUrl()
  }, [syncUrl])

  const resetPage = () => {
    setUrlSyncEnabled(true)
    setPage(1)
  }

  const fetchOperations = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        entityType: entityFilter,
        direction: "all",
        localModel: localModelFilter,
        localId: localIdFilter,
        operationType: operationTypeFilter,
        failureState: failureStateFilter,
        resourceId: resourceIdFilter,
        page: String(page),
        pageSize: String(pageSize),
      })
      if (createdFrom) params.set("createdFrom", createdFrom)
      if (createdTo) params.set("createdTo", createdTo)
      const data = await fetchJson<{ data?: XeroOperation[]; total?: number }>(`/api/admin/xero/operations?${params.toString()}`, undefined, "Failed to fetch Xero operations")
      setOperations(data.data ?? [])
      setTotal(data.total ?? 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Xero operation history")
    } finally {
      setLoading(false)
    }
  }, [
    createdFrom,
    createdTo,
    entityFilter,
    failureStateFilter,
    localIdFilter,
    localModelFilter,
    operationTypeFilter,
    page,
    resourceIdFilter,
    statusFilter,
  ])

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

  const resolveOperation = async (operationId: string) => {
    const reason = window.prompt("How was this resolved in Xero? This drops it off the active failure list.", "Resolved manually in Xero")
    if (reason === null) return
    setResolvingOperationId(operationId)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>(
        `/api/admin/xero/operations/${operationId}/resolve`,
        { reason },
        "Failed to resolve Xero operation"
      )
      onMessage(data.message || "Xero operation marked resolved.")
      await fetchOperations()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve Xero operation")
    } finally {
      setResolvingOperationId(null)
    }
  }

  const resetStaleRunning = async () => {
    setResettingStale(true)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>("/api/admin/xero/operations/reset-stale-running", undefined, "Failed to reset stale running Xero operations")
      onMessage(data.message || "Reset stale running Xero operations.")
      await fetchOperations()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset stale running Xero operations")
    } finally {
      setResettingStale(false)
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
          <Button variant="outline" size="sm" onClick={() => void resetStaleRunning()} disabled={resettingStale}>
            {resettingStale ? "Resetting..." : "Reset stale running"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void fetchOperations()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <details className="rounded-md border bg-slate-50 p-3 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-700">What do these statuses mean?</summary>
          <ul className="mt-2 space-y-1">
            <li><span className="font-medium">PENDING</span> — queued, waiting for the next sync run. No action needed.</li>
            <li><span className="font-medium">RUNNING</span> — being sent to Xero now. If it stays running for a long time it is stale — use &ldquo;Reset stale running&rdquo; above.</li>
            <li><span className="font-medium">WAITING_PAYMENT</span> — paused until the related payment settles. No action needed.</li>
            <li><span className="font-medium">SUCCEEDED</span> — completed in Xero. No action needed.</li>
            <li><span className="font-medium">PARTIAL</span> — some steps succeeded; retry to finish the rest.</li>
            <li><span className="font-medium">FAILED</span> — could not complete. Open the row for the error, fix the cause if needed, then Retry. Use &ldquo;Retry Active Failed&rdquo; to requeue all replayable failures.</li>
          </ul>
        </details>
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <FilterSelect label="Status" value={statusFilter} onValueChange={(value) => { setStatusFilter(value); resetPage() }} values={["all", "FAILED", "PENDING", "PARTIAL", "RUNNING", "WAITING_PAYMENT", "SUCCEEDED"]} />
          <FilterSelect label="Entity" value={entityFilter} onValueChange={(value) => { setEntityFilter(value); resetPage() }} values={["all", "CONTACT", "CONTACT_GROUP", "INVOICE", "PAYMENT", "CREDIT_NOTE", "ALLOCATION", "SUBSCRIPTION"]} />
          <FilterSelect label="Local Model" value={localModelFilter} onValueChange={(value) => { setLocalModelFilter(value); resetPage() }} values={["all", "Member", "Booking", "Payment", "BookingModification", "MemberSubscription"]} />
          <FilterSelect label="Failure" value={failureStateFilter} onValueChange={(value) => { setFailureStateFilter(value); resetPage() }} values={["all", "ACTIVE", "REPAIRED", "SUPERSEDED"]} />
        </div>
        <div className="grid gap-3 md:grid-cols-5">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-op-local-id">Local ID</Label>
            <Input id="xero-op-local-id" value={localIdFilter} onChange={(event) => { setLocalIdFilter(event.target.value); resetPage() }} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-op-operation-type">Operation</Label>
            <Input id="xero-op-operation-type" value={operationTypeFilter === "all" ? "" : operationTypeFilter} onChange={(event) => { setOperationTypeFilter(event.target.value || "all"); resetPage() }} placeholder="CREATE" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-op-resource-id">Resource ID</Label>
            <Input id="xero-op-resource-id" value={resourceIdFilter} onChange={(event) => { setResourceIdFilter(event.target.value); resetPage() }} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-op-created-from">Created From</Label>
            <Input id="xero-op-created-from" type="date" value={createdFrom} onChange={(event) => { setCreatedFrom(event.target.value); resetPage() }} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-op-created-to">Created To</Label>
            <Input id="xero-op-created-to" type="date" value={createdTo} onChange={(event) => { setCreatedTo(event.target.value); resetPage() }} />
          </div>
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
                resolving={resolvingOperationId === operation.id}
                onRetry={() => void retryOperation(operation.id)}
                onMarkNonReplayable={() => void markNonReplayable(operation.id)}
                onResolve={() => void resolveOperation(operation.id)}
              />
            ))}
          </div>
        )}
        {total > pageSize ? (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Showing {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, total)} of {total}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => { setUrlSyncEnabled(true); setPage((value) => value - 1) }}>Previous</Button>
              <Button variant="outline" size="sm" disabled={page * pageSize >= total} onClick={() => { setUrlSyncEnabled(true); setPage((value) => value + 1) }}>Next</Button>
            </div>
          </div>
        ) : null}
      </div>
    </SectionCard>
  )
}

function OperationItem({
  operation,
  retrying,
  markingNonReplayable,
  resolving,
  onRetry,
  onMarkNonReplayable,
  onResolve,
}: {
  operation: XeroOperation
  retrying: boolean
  markingNonReplayable: boolean
  resolving: boolean
  onRetry: () => void
  onMarkNonReplayable: () => void
  onResolve: () => void
}) {
  const resolved = Boolean(operation.manuallyResolvedAt)
  const isFailedOrPartial = operation.status === "FAILED" || operation.status === "PARTIAL"
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default" className={operationStatusClass(operation.status)}>{operation.status}</Badge>
        {resolved ? (
          <Badge variant="default" className="bg-green-100 text-green-800">Resolved in Xero</Badge>
        ) : operation.failureState ? (
          <Badge variant="default" className={failureStateBadgeClass(operation.failureState)}>{failureStateLabel(operation.failureState)}</Badge>
        ) : null}
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
      {operation.failureStateReason && operation.status === "FAILED" && !resolved ? <p className="text-xs text-muted-foreground">{operation.failureStateReason}</p> : null}
      {resolved ? (
        <p className="text-xs text-green-700">
          Resolved in Xero{operation.manuallyResolvedReason ? `: ${operation.manuallyResolvedReason}` : ""}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {operation.supported && operation.failureState !== "REPAIRED" && operation.failureState !== "SUPERSEDED" ? (
            <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
              {retrying ? "Queueing..." : "Retry in background"}
            </Button>
          ) : operation.reason && isFailedOrPartial ? (
            <p className="text-xs text-muted-foreground">{operation.reason}</p>
          ) : null}
          {operation.replayable && isFailedOrPartial ? (
            <Button variant="outline" size="sm" onClick={onMarkNonReplayable} disabled={markingNonReplayable}>
              {markingNonReplayable ? "Archiving..." : "Mark non-replayable"}
            </Button>
          ) : null}
          {isFailedOrPartial ? (
            <Button variant="outline" size="sm" onClick={onResolve} disabled={resolving}>
              {resolving ? "Resolving..." : "Resolve (fixed in Xero)"}
            </Button>
          ) : null}
        </div>
      )}
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
