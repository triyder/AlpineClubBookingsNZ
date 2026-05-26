"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { fetchJson, postJson } from "./api"
import {
  FilterSelect,
  formatJson,
  inboundEventActionLabel,
  operationStatusClass,
  SectionCard,
  shortId,
  type ToggleSection,
} from "./shared"
import type { XeroInboundEvent } from "./types"

export function InboundEventsPanel({
  connected,
  open,
  onToggle,
  onMessage,
  onRefreshOperations,
  onRefreshDiagnostics,
  refreshToken,
}: {
  connected: boolean
  open: boolean
  onToggle: ToggleSection
  onMessage: (message: string) => void
  onRefreshOperations: () => void
  onRefreshDiagnostics: () => void
  refreshToken: number
}) {
  const [events, setEvents] = useState<XeroInboundEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [replayingEventId, setReplayingEventId] = useState<string | null>(null)

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        eventCategory: categoryFilter,
        source: "all",
        limit: "25",
      })
      const data = await fetchJson<{ data?: XeroInboundEvent[] }>(`/api/admin/xero/inbound-events?${params.toString()}`, undefined, "Failed to fetch Xero inbound events")
      setEvents(data.data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Xero inbound events")
    } finally {
      setLoading(false)
    }
  }, [categoryFilter, statusFilter])

  useEffect(() => {
    if (connected && open) void fetchEvents()
  }, [connected, fetchEvents, open])

  useEffect(() => {
    if (connected && open && refreshToken !== 0) void fetchEvents()
  }, [connected, fetchEvents, open, refreshToken])

  const replay = async (eventId: string) => {
    setReplayingEventId(eventId)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>(`/api/admin/xero/inbound-events/${eventId}/replay`, undefined, "Failed to replay Xero inbound event")
      onMessage(data.message || "Xero inbound event replayed.")
      await fetchEvents()
      onRefreshOperations()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to replay Xero inbound event")
    } finally {
      setReplayingEventId(null)
    }
  }

  return (
    <SectionCard
      id="xero-section-inbound"
      title="Inbound Events"
      description="Stored webhook events and their reconciliation state."
      open={open}
      onToggle={(nextOpen) => onToggle("inbound", nextOpen)}
      actions={<Button variant="outline" size="sm" onClick={() => void fetchEvents()} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</Button>}
    >
      <div className="space-y-4">
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <FilterSelect label="Status" value={statusFilter} onValueChange={setStatusFilter} values={["all", "FAILED", "RECEIVED", "PROCESSING", "PROCESSED"]} />
          <FilterSelect label="Category" value={categoryFilter} onValueChange={setCategoryFilter} values={["all", "CONTACT", "INVOICE", "PAYMENT", "CREDIT_NOTE"]} />
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading stored inbound events...</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No stored inbound events found.</p>
        ) : (
          <div className="space-y-3">
            {events.map((event) => (
              <div key={event.id} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="default" className={operationStatusClass(event.status)}>{event.status}</Badge>
                  <span className="text-sm font-medium">{event.eventCategory ?? "UNKNOWN"} {event.eventType}</span>
                  <span className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString("en-NZ")}</span>
                </div>
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span>Source: {event.source}</span>
                  <span>Correlation: <code>{shortId(event.correlationKey)}</code></span>
                  {event.resourceId ? (
                    <span>
                      Resource:{" "}
                      {event.xeroObjectUrl ? (
                        <a href={event.xeroObjectUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{shortId(event.resourceId)}</a>
                      ) : shortId(event.resourceId)}
                    </span>
                  ) : null}
                  {event.processedAt ? <span>Processed: {new Date(event.processedAt).toLocaleString("en-NZ")}</span> : null}
                </div>
                {event.errorMessage ? <p className="text-sm text-red-700">{event.errorMessage}</p> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => void replay(event.id)} disabled={!event.canReplay || replayingEventId === event.id}>
                    {replayingEventId === event.id ? "Replaying..." : inboundEventActionLabel(event.status)}
                  </Button>
                  {!event.canReplay ? <p className="text-xs text-muted-foreground">This event is currently being processed.</p> : null}
                </div>
                <details className="rounded-md bg-slate-50 p-2">
                  <summary className="cursor-pointer text-xs font-medium text-slate-700">View stored payload</summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded border bg-white p-2 text-[11px]">{formatJson(event.payload)}</pre>
                </details>
              </div>
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  )
}
