"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  LodgeSelect,
  initialLodgeIdFromLocation,
  useLodgeOptions,
} from "@/components/lodge-select"
import { formatDateOnly, getTodayDateOnly } from "@/lib/date-only"
import { OccupancyCalendar, type CalendarTone } from "@/components/admin/occupancy-calendar"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import type { RosterDayStatus, RosterDayStatusResult } from "@/lib/roster-status"

interface Guest {
  id: string
  bookingId: string
  firstName: string
  lastName: string
  ageTier: string
}

interface Assignment {
  id: string
  choreTemplateId: string
  choreTemplateName: string
  choreDescription: string | null
  choreSortOrder: number
  bookingGuestId: string | null
  guestName: string | null
  guestAgeTier: string | null
  bookingId: string
  status: "SUGGESTED" | "CONFIRMED" | "COMPLETED"
}

interface ChoreTemplate {
  id: string
  name: string
  description: string | null
  recommendedPeopleMin: number
  recommendedPeopleMax: number
  isEssential: boolean
  ageRestriction: string
  conditionalNote: string | null
  minAge: number
  sortOrder: number
  active: boolean
}

interface RosterData {
  date: string
  guests: Guest[]
  assignments: Assignment[]
  templates: ChoreTemplate[]
  guestHistory: Record<string, Array<{ date: string; choreName: string }>>
  guestCount: number
}

const AGE_TIER_COLORS: Record<string, string> = {
  // #2188 P2 (lens MEDIUM-5): demographic age tiers on the CATEGORICAL scales
  // (never severity), one assignment shared with admin-family-group-ui-helpers'
  // AGE_TIER_COLORS — same tier, same colour everywhere.
  ADULT: "bg-cat4-3 text-cat4-11",
  YOUTH: "bg-cat3-3 text-cat3-11",
  CHILD: "bg-cat2-3 text-cat2-11",
}

// Per-date roster status → calendar overlay tone + compact label. `no-guests`
// dates are intentionally omitted (they carry no overlay).
const ROSTER_STATUS_OVERLAY: Record<
  Exclude<RosterDayStatus, "no-guests">,
  { tone: CalendarTone; label: string }
> = {
  "needs-roster": { tone: "red", label: "Needs roster" },
  suggested: { tone: "amber", label: "Suggested" },
  "needs-attention": { tone: "orange", label: "Needs chores" },
  confirmed: { tone: "green", label: "Confirmed" },
}

const ROSTER_LEGEND: Array<{ tone: CalendarTone; label: string }> = [
  { tone: "red", label: "Needs roster" },
  { tone: "amber", label: "Suggested (unconfirmed)" },
  { tone: "orange", label: "Confirmed — some guests need chores" },
  { tone: "green", label: "Confirmed" },
]

function formatDateForInput(d: Date): string {
  return formatDateOnly(d)
}

export default function RosterPage() {
  // Roster assignments are lodge operations; the roster PUT route enforces
  // lodge:edit, so a lodge:view admin sees this screen read-only (#1940).
  const canEdit = useAdminAreaEditAccess("lodge")
  const [selectedDate, setSelectedDate] = useState(formatDateForInput(getTodayDateOnly()))
  const [roster, setRoster] = useState<RosterData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [includeNonEssential, setIncludeNonEssential] = useState<boolean | null>(null)
  const [sendingEmail, setSendingEmail] = useState(false)
  // #1785 (#1769b sweep): the admin chooses, per send, whether to email the
  // roster. The dialog opens on the "Email Roster to Guests" click; the button
  // only renders when at least one guest is affected, so opening it already
  // means an email would send. `lastEmailSuppressed` records whether the last
  // completed send suppressed the emails (for truthful success copy).
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false)
  const [lastEmailSuppressed, setLastEmailSuppressed] = useState(false)
  // Lodge context for the roster; LodgeSelect renders nothing (and reports
  // the sole lodge) while fewer than two lodges exist (ADR-002).
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin")
  const [lodgeId, setLodgeId] = useState<string | null>(initialLodgeIdFromLocation)
  const [overlayByDate, setOverlayByDate] = useState<
    Record<string, { tone: CalendarTone; label: string }>
  >({})
  // Latest selected lodge, read after an async overlay fetch resolves so a
  // slow earlier-lodge response cannot repaint the current lodge's overlay
  // (the roster list fetch is already ordering-guarded via AbortController).
  const lodgeIdRef = useRef(lodgeId)
  useEffect(() => {
    lodgeIdRef.current = lodgeId
  }, [lodgeId])

  // Load the roster colour statuses for a month and merge them into the
  // calendar overlay. `no-guests` dates are skipped (no overlay). Failures are
  // swallowed: the overlay is a non-essential decoration over the calendar.
  const loadMonthStatus = useCallback(async (month: string) => {
    try {
      const query = new URLSearchParams({ month })
      // Scope the overlay to the selected lodge so its badges agree with the
      // lodge-filtered roster list below (#1587 item 3). Mirrors `rosterUrl`:
      // omitted when no lodge is selected, keeping single-lodge behaviour.
      if (lodgeId) query.set("lodgeId", lodgeId)
      const res = await fetch(`/api/admin/roster/status?${query.toString()}`)
      if (!res.ok) return
      const data: { month: string; statuses: RosterDayStatusResult[] } = await res.json()
      // Drop a response for a lodge the user has since switched away from, so a
      // late earlier-lodge fetch never repaints the current lodge's overlay.
      if (lodgeId !== lodgeIdRef.current) return
      // Merge this month's statuses into the overlay, and explicitly DELETE any
      // date that has dropped to `no-guests` (e.g. a booking cancelled elsewhere)
      // so a stale coloured badge from a previous load never lingers.
      setOverlayByDate((prev) => {
        const next = { ...prev }
        for (const result of data.statuses ?? []) {
          if (result.status === "no-guests") {
            delete next[result.date]
          } else {
            next[result.date] = ROSTER_STATUS_OVERLAY[result.status]
          }
        }
        return next
      })
    } catch {
      // Non-essential overlay; ignore load failures.
    }
  }, [lodgeId])

  const rosterUrl = useCallback(
    (date: string, params: Record<string, string> = {}) => {
      const query = new URLSearchParams(params)
      if (lodgeId) query.set("lodgeId", lodgeId)
      const queryString = query.toString()
      return `/api/admin/roster/${encodeURIComponent(date)}${queryString ? `?${queryString}` : ""}`
    },
    [lodgeId],
  )

  const fetchRoster = useCallback(async (date: string, signal?: AbortSignal) => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch(
        rosterUrl(
          date,
          includeNonEssential !== null
            ? { includeNonEssential: String(includeNonEssential) }
            : {},
        ),
        { signal },
      )
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to fetch roster")
      }
      const data: RosterData = await res.json()
      setRoster(data)
      // #1785: the "last send suppressed" note is scoped to the currently
      // loaded date — drop it whenever a roster (re)loads so a suppress on one
      // date can never keep asserting itself over another date's roster.
      setLastEmailSuppressed(false)
      // Refresh the month overlay so an auto-suggest on opening a needs-roster
      // date (and every mutation that re-fetches) is reflected on the calendar.
      void loadMonthStatus(date.slice(0, 7))
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }, [includeNonEssential, rosterUrl, loadMonthStatus])

  useEffect(() => {
    if (!selectedDate) return
    // Abort the in-flight request when the date or lodge changes so a slow
    // earlier response cannot overwrite the newer selection.
    const controller = new AbortController()
    fetchRoster(selectedDate, controller.signal)
    return () => controller.abort()
  }, [selectedDate, fetchRoster])

  // Drop every overlay badge when the lodge filter changes so a previously
  // loaded month (e.g. one navigated to but not currently selected) can never
  // keep showing the previous lodge's colours (#1587 item 3). The selected
  // month repopulates via the fetchRoster effect above; other months
  // repopulate when navigated to via `onVisibleMonthChange`.
  useEffect(() => {
    setOverlayByDate({})
  }, [lodgeId])

  async function handleReassign(assignmentId: string, bookingGuestId: string) {
    setSaving(true)
    try {
      const res = await fetch(rosterUrl(selectedDate), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reassign", assignmentId, bookingGuestId }),
      })
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON)
        return
      }
      if (!res.ok) throw new Error("Failed to reassign")
      fetchRoster(selectedDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove(assignmentId: string) {
    if (!confirm("Remove this person from the chore?")) return
    setSaving(true)
    try {
      const res = await fetch(rosterUrl(selectedDate), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", assignmentId }),
      })
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON)
        return
      }
      if (!res.ok) throw new Error("Failed to remove")
      fetchRoster(selectedDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleRegenerate() {
    const hasConfirmedAssignments =
      roster?.assignments.some(
        (assignment) =>
          assignment.status === "CONFIRMED" || assignment.status === "COMPLETED"
      ) ?? false

    if (
      hasConfirmedAssignments &&
      !confirm(
        "This will replace the current confirmed roster with a new editable suggested roster. Continue?"
      )
    ) {
      return
    }

    setSaving(true)
    setError("")
    try {
      const res = await fetch(rosterUrl(selectedDate), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "regenerate",
          includeNonEssential: includeNonEssential ?? undefined,
          overwriteConfirmed: hasConfirmedAssignments || undefined,
        }),
      })
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON)
        return
      }
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || "Failed to regenerate roster")
      }
      fetchRoster(selectedDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleAddAssignment(choreTemplateId: string) {
    if (!roster || roster.guests.length === 0) return
    const guest = roster.guests[0]
    setSaving(true)
    try {
      const res = await fetch(rosterUrl(selectedDate), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          choreTemplateId,
          bookingGuestId: guest.id,
          bookingId: guest.bookingId,
        }),
      })
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON)
        return
      }
      if (!res.ok) throw new Error("Failed to add")
      fetchRoster(selectedDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleConfirm() {
    if (!confirm("Confirm all suggested assignments? This marks them as final.")) return
    setSaving(true)
    try {
      const res = await fetch(rosterUrl(selectedDate), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm" }),
      })
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON)
        return
      }
      if (!res.ok) throw new Error("Failed to confirm")
      fetchRoster(selectedDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  // #1785: the click now asks — via the notify dialog — whether to email. The
  // button only renders when at least one guest is affected, so opening the
  // dialog already satisfies "ask only when an email would actually send".
  function handleSendEmail() {
    setNotifyDialogOpen(true)
  }

  async function performSendEmail(notifyMember: boolean) {
    setSendingEmail(true)
    // Clear the prior "last send suppressed" note at the start of every send
    // attempt; the outcome below re-sets it only when this send suppresses.
    setLastEmailSuppressed(false)
    try {
      const res = await fetch(rosterUrl(selectedDate), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "email", notifyMember }),
      })
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON)
        return
      }
      if (!res.ok) throw new Error("Failed to send emails")
      const data = await res.json()
      // Suppress branch: nothing was sent and existing chore links stay valid.
      if (data.suppressed) {
        setLastEmailSuppressed(true)
        alert(
          "No emails sent. Existing chore links remain valid. Your choice is recorded in the audit log."
        )
        return
      }
      const skippedNote = data.skipped
        ? ` ${data.skipped} guest(s) skipped (opted out of chore roster emails).`
        : ""
      if (data.partialFailure) {
        alert(`Roster emails sent with ${data.failed} failure(s).${skippedNote}`)
      } else {
        alert(`Roster emails sent successfully!${skippedNote}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSendingEmail(false)
    }
  }

  // Group assignments by chore template
  const assignmentsByChore = new Map<string, Assignment[]>()
  if (roster) {
    for (const a of roster.assignments) {
      if (!assignmentsByChore.has(a.choreTemplateId)) {
        assignmentsByChore.set(a.choreTemplateId, [])
      }
      assignmentsByChore.get(a.choreTemplateId)!.push(a)
    }
  }

  // Get chores that have assignments, sorted by sortOrder
  const choreIds = [...assignmentsByChore.keys()]
  const assignedChores = roster
    ? choreIds
        .map((id) => roster.templates.find((t) => t.id === id) ?? null)
        .filter((t): t is ChoreTemplate => t !== null)
        .sort((a, b) => a.sortOrder - b.sortOrder)
    : []

  // Chores with no assignments (for "add" button)
  const unassignedChores = roster
    ? roster.templates.filter((t) => !assignmentsByChore.has(t.id))
    : []

  const hasAnySuggested = roster?.assignments.some((a) => a.status === "SUGGESTED") ?? false
  const isConfirmed = roster?.assignments.length
    ? roster.assignments.every((a) => a.status === "CONFIRMED" || a.status === "COMPLETED")
    : false

  // Booking-granularity coverage for the selected night: a staying booking is
  // "uncovered" if no assignment carries its bookingId. Surfaced as a banner
  // only when the roster is otherwise fully confirmed.
  const stayingBookingIds = new Set((roster?.guests ?? []).map((g) => g.bookingId))
  const coveredBookingIds = new Set((roster?.assignments ?? []).map((a) => a.bookingId))
  const uncoveredCount = [...stayingBookingIds].filter(
    (id) => !coveredBookingIds.has(id)
  ).length

  const selectedDatePathSegment = encodeURIComponent(selectedDate)

  function getGuestHistoryDisplay(guestId: string): string {
    if (!roster?.guestHistory[guestId]) return ""
    return roster.guestHistory[guestId]
      .map((h) => {
        const d = new Date(h.date)
        const dayDiff = Math.round(
          (new Date(selectedDate).getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
        )
        return `Day -${dayDiff}: ${h.choreName}`
      })
      .join(", ")
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the chore roster but cannot change it. Lodge
      edit access is required.
    </AdminViewOnlySectionBanner>
  )

  return (
    <div>
      {/*
        #2160: on THIS page the heading block comes first, so that a
        screen-reader user knows which area they are on before the banner tells
        them they have view-only access to it. `mb-6` replaces the `space-y-6`
        gap this block had as the stack's first child, so spacing is unchanged
        in both states: the `mb-6` lives on the banner's inner div, which only
        renders for a view-only admin, and the permanently-mounted
        `role="status"` wrapper an edit-capable admin gets has no height and no
        margin.

        This ordering is NOT the house rule — see the fuller note on
        `/admin/book`. It is applied only on these two pages. Everywhere else
        the banner stays the FIRST child of the outermost wrapper in EVERY
        render branch, so the `role="status"` region keeps its DOM position when
        a fetch settles instead of being re-created already populated. This page
        renders in a single branch, so the reorder is free; it has not been
        propagated to the other single-branch sections, because keying the
        banner's position on whether a section has a loading branch is not
        something a reader can check at the render site.
      */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Chore Roster</h1>
          <p className="text-muted-foreground mt-1">
            Review and manage daily chore assignments
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <LodgeSelect
            lodges={lodges}
            value={lodgeId}
            onChange={setLodgeId}
            loading={lodgesLoading}
          />
          <a
            href={`/admin/roster/${selectedDatePathSegment}/print${
              lodgeId ? `?lodgeId=${encodeURIComponent(lodgeId)}` : ""
            }`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="outline">Print Roster</Button>
          </a>
        </div>
      </div>

      {viewOnlyBanner}
      <div className="space-y-6">

      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Select Date</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <Label htmlFor="date">Date</Label>
              <Input
                id="date"
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
              />
            </div>
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="includeNonEssential"
                checked={includeNonEssential ?? false}
                onChange={(e) =>
                  setIncludeNonEssential(e.target.checked ? true : null)
                }
                className="rounded border-input"
              />
              <Label htmlFor="includeNonEssential">Include non-essential chores</Label>
            </div>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              onClick={handleRegenerate}
              disabled={loading || saving}
            >
              Regenerate Roster
            </ViewOnlyActionButton>
          </div>
          <div className="mt-4">
            <OccupancyCalendar
              mode="single"
              selectedStartDate={selectedDate}
              selectedEndDate={selectedDate}
              onSelectionChange={({ startDate }) => setSelectedDate(startDate)}
              overlayByDate={overlayByDate}
              overlayLegend={ROSTER_LEGEND}
              onVisibleMonthChange={loadMonthStatus}
            />
          </div>
        </CardContent>
      </Card>

      {loading && <div className="text-center py-8">Loading roster...</div>}

      {roster && !loading && (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>
                    Roster for {new Date(selectedDate + "T00:00:00").toLocaleDateString("en-NZ", {
                      weekday: "long",
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}
                  </CardTitle>
                  <CardDescription>
                    {roster.guestCount} guest{roster.guestCount !== 1 ? "s" : ""} staying
                    {roster.guestCount >= 20 ? " (high occupancy)" : " (low occupancy)"}
                    {" · "}
                    {roster.assignments.length} assignment{roster.assignments.length !== 1 ? "s" : ""}
                  </CardDescription>
                  {lastEmailSuppressed && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Last send: no emails sent — existing chore links remain
                      valid (recorded in the audit log).
                    </p>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  {hasAnySuggested && (
                    <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={handleConfirm} disabled={saving}>
                      Confirm Roster
                    </ViewOnlyActionButton>
                  )}
                  {isConfirmed && roster.assignments.length > 0 && (
                    <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" onClick={handleSendEmail} disabled={sendingEmail}>
                      {sendingEmail ? "Sending..." : "Email Roster to Guests"}
                    </ViewOnlyActionButton>
                  )}
                </div>
              </div>
            </CardHeader>
          </Card>

          {isConfirmed && uncoveredCount > 0 && (
            <div className="rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
              {uncoveredCount} booking{uncoveredCount === 1 ? "" : "s"} staying this
              night {uncoveredCount === 1 ? "has" : "have"} no chores — click
              Regenerate Roster to include {uncoveredCount === 1 ? "it" : "them"}.
            </div>
          )}

          {roster.guests.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No confirmed guests staying on this date.
              </CardContent>
            </Card>
          ) : roster.assignments.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No chore assignments for this date. Click &quot;Regenerate Roster&quot; to auto-suggest.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {assignedChores.map((template) => {
                const assignments = assignmentsByChore.get(template.id) ?? []
                return (
                  <Card key={template.id}>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <span className="text-lg font-mono text-muted-foreground">
                            {template.sortOrder}.
                          </span>
                          <CardTitle className="text-lg">{template.name}</CardTitle>
                          {!template.isEssential && (
                            <Badge variant="outline">Optional</Badge>
                          )}
                          {template.conditionalNote && (
                            <span className="text-xs text-muted-foreground italic">
                              {template.conditionalNote}
                            </span>
                          )}
                        </div>
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          variant="ghost"
                          size="sm"
                          onClick={() => handleAddAssignment(template.id)}
                          disabled={saving}
                        >
                          + Add Person
                        </ViewOnlyActionButton>
                      </div>
                      {template.description && (
                        <CardDescription className="ml-10">
                          {template.description}
                        </CardDescription>
                      )}
                    </CardHeader>
                    <CardContent className="pt-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Guest</TableHead>
                            <TableHead>Age Tier</TableHead>
                            <TableHead>Recent History (4 days)</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {assignments.map((a) => (
                            <TableRow key={a.id}>
                              <TableCell>
                                <select
                                  value={a.bookingGuestId ?? ""}
                                  onChange={(e) => {
                                    if (e.target.value) handleReassign(a.id, e.target.value)
                                  }}
                                  disabled={saving || !canEdit}
                                  className="flex h-8 w-full max-w-[200px] rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                                >
                                  <option value="">Unassigned</option>
                                  {roster.guests.map((g) => (
                                    <option key={g.id} value={g.id}>
                                      {g.firstName} {g.lastName}
                                    </option>
                                  ))}
                                </select>
                              </TableCell>
                              <TableCell>
                                {a.guestAgeTier && (
                                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${AGE_TIER_COLORS[a.guestAgeTier] ?? ""}`}>
                                    {a.guestAgeTier}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                {a.bookingGuestId && (
                                  <span className="text-xs text-muted-foreground">
                                    {getGuestHistoryDisplay(a.bookingGuestId) || "No recent history"}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant={
                                    a.status === "CONFIRMED"
                                      ? "default"
                                      : a.status === "COMPLETED"
                                      ? "secondary"
                                      : "outline"
                                  }
                                >
                                  {a.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                <ViewOnlyActionButton
                                  canEdit={canEdit}
                                  describeReason={false}
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleRemove(a.id)}
                                  disabled={saving}
                                >
                                  Remove
                                </ViewOnlyActionButton>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                )
              })}

              {/* Unassigned chores */}
              {unassignedChores.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Unrostered Chores</CardTitle>
                    <CardDescription>
                      These chores have no assignments for this date. Click to add.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {unassignedChores.map((t) => (
                        <ViewOnlyActionButton
                          key={t.id}
                          canEdit={canEdit}
                          describeReason={false}
                          variant="outline"
                          size="sm"
                          onClick={() => handleAddAssignment(t.id)}
                          disabled={saving || roster.guests.length === 0}
                        >
                          + {t.name}
                          {!t.isEssential && (
                            <span className="text-xs ml-1 opacity-60">(optional)</span>
                          )}
                        </ViewOnlyActionButton>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </>
      )}

      {/* #1785 (#1769b sweep): per-send email choice, mirroring the #1705/#1769a
          pattern. Emailing reissues fresh 48-hour chore links to every affected
          guest; suppressing sends nothing and leaves any previously-issued chore
          links valid. Both choices are recorded — the suppression is audited as
          `notifyMember: false`. The triggering button only renders when at least
          one guest is affected, so opening this already means an email would
          send. */}
      <Dialog open={notifyDialogOpen} onOpenChange={setNotifyDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email the roster to guests?</DialogTitle>
            <DialogDescription>
              Emailing sends each affected guest a fresh chore link — guests
              who opted out of chore-roster emails are still skipped. Choosing
              not to email leaves any previously-sent chore links valid and
              sends nothing. Your choice is recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={sendingEmail}
              onClick={() => {
                setNotifyDialogOpen(false)
                void performSendEmail(false)
              }}
            >
              Don’t email — keep existing links
            </Button>
            <Button
              disabled={sendingEmail}
              onClick={() => {
                setNotifyDialogOpen(false)
                void performSendEmail(true)
              }}
            >
              Email guests the roster
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  )
}
