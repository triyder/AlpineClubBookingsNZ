"use client"

import { useEffect, useState, useCallback } from "react"
import {
  cancellationRuleSetsEqual,
  normalizeCancellationRule,
} from "@/lib/cancellation-rules"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { CancellationRulesEditor } from "./cancellation-rules-editor"
import { PolicyPreview } from "./policy-preview"
import { PolicyFeedback } from "./policy-feedback"
import { PolicyScopeSelect, usePolicyScopeLodgeName } from "./policy-scope-select"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state"
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import type { BookingPeriod, PolicyRule } from "./types"

const NEW_PERIOD_RULES: PolicyRule[] = [
  { daysBeforeStay: 21, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0, creditFixedFeeCents: 0 },
  { daysBeforeStay: 14, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0, creditFixedFeeCents: 0 },
  { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0, creditFixedFeeCents: 0 },
]

/**
 * One open period editor's draft. This section's snapshot is a LIST, so the
 * draft/snapshot pair that `useSectionEditState` owns is scoped to the ROW
 * being edited, not to the section: the form below mounts one hook instance per
 * open editor (keyed on the row id) and the list itself stays plain state.
 */
interface PeriodDraft {
  name: string
  startDate: string
  endDate: string
  holdEnabled: boolean
  holdDays: number
  rules: PolicyRule[]
}

const NEW_PERIOD_DRAFT: PeriodDraft = {
  name: "",
  startDate: "",
  endDate: "",
  holdEnabled: true,
  holdDays: 5,
  rules: NEW_PERIOD_RULES,
}

function toDraft(period: BookingPeriod): PeriodDraft {
  return {
    name: period.name,
    startDate: period.startDate.split("T")[0],
    endDate: period.endDate.split("T")[0],
    holdEnabled: period.nonMemberHoldEnabled ?? true,
    holdDays: period.nonMemberHoldDays,
    rules: period.cancellationRules.map((rule) => normalizeCancellationRule(rule)),
  }
}

function draftsEqual(a: PeriodDraft, b: PeriodDraft) {
  return (
    a.name === b.name &&
    a.startDate === b.startDate &&
    a.endDate === b.endDate &&
    a.holdEnabled === b.holdEnabled &&
    a.holdDays === b.holdDays &&
    cancellationRuleSetsEqual(a.rules, b.rules)
  )
}

function PeriodForm({
  periodId,
  initial,
  canEdit,
  onSubmit,
  onCancel,
  onError,
}: {
  /** `null` while creating — there is no persisted row to be unchanged from. */
  periodId: string | null
  initial: PeriodDraft
  canEdit: boolean | undefined
  /** Persists the draft and closes the form. Throws to surface a failure. */
  onSubmit: (draft: PeriodDraft) => Promise<PeriodDraft>
  onCancel: () => void
  onError: (message: string) => void
}) {
  const section = useSectionEditState<PeriodDraft>({
    initial,
    save: onSubmit,
    // The section renders its own `PolicyFeedback` above the list, so the
    // success copy is set by the parent when the form closes.
    successMessage: "",
    // #2143: an Edit -> Save that changed nothing must not reach the PUT, which
    // writes a `booking-period.update` audit entry with a `before`/`after` pair
    // unconditionally — identical halves and all — and busts the public-page
    // cache. Creating is the first-save exception (the same one the group
    // discount card makes): there is no persisted row for the draft to be
    // unchanged FROM, so a create is always savable once it validates.
    isDirty: (draft, saved) => periodId === null || !draftsEqual(draft, saved),
    isValid: (draft) =>
      Boolean(draft.name) && Boolean(draft.startDate) && Boolean(draft.endDate),
  })

  const { draft, saving, dirty, valid, error } = section

  // The hook owns the save-failure message; this section presents every message
  // in one place above the list, so mirror it up rather than rendering twice.
  useEffect(() => {
    if (error) onError(error)
  }, [error, onError])

  if (!draft) return null

  return (
    <Card className="border-blue-200 bg-blue-50/30">
      <CardContent className="pt-6 space-y-4">
        <h3 className="font-semibold">
          {periodId ? "Edit Period" : "New Period"}
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="pName">Period Name</Label>
            <Input
              id="pName"
              value={draft.name}
              onChange={(e) => section.setDraft({ name: e.target.value })}
              placeholder="e.g. School Holidays Jul 2026"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pHold">Non-member hold days</Label>
            <Input
              id="pHold"
              type="number"
              min="1"
              max="365"
              value={draft.holdDays}
              onChange={(e) =>
                section.setDraft({ holdDays: parseInt(e.target.value) || 5 })
              }
              className="w-24"
              disabled={!draft.holdEnabled}
            />
            <p className="text-xs text-muted-foreground">
              {draft.holdEnabled
                ? "Used only when this period applies and Members First is enabled."
                : "Stored but inactive while this period uses First Paid, First In."}
            </p>
          </div>
          <label className="flex items-start gap-3 rounded-md border p-3 md:col-span-2">
            <Checkbox
              checked={draft.holdEnabled}
              onCheckedChange={(v) => section.setDraft({ holdEnabled: v === true })}
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">Members First for this period</span>
              <span className="block text-xs text-muted-foreground">
                Disable this to let bookings in this date range proceed as First Paid, First In.
              </span>
            </span>
          </label>
          <div className="space-y-2">
            <Label htmlFor="pStart">Start Date</Label>
            <Input
              id="pStart"
              type="date"
              value={draft.startDate}
              onChange={(e) => section.setDraft({ startDate: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pEnd">End Date</Label>
            <Input
              id="pEnd"
              type="date"
              value={draft.endDate}
              onChange={(e) => section.setDraft({ endDate: e.target.value })}
            />
          </div>
        </div>

        <div>
          <Label className="text-sm font-semibold">Cancellation Rules for this Period</Label>
          <CancellationRulesEditor
            rules={draft.rules}
            onChange={(rules) => section.setDraft({ rules })}
          />
        </div>

        <div>
          <Label className="text-sm font-semibold">Preview</Label>
          <PolicyPreview rules={draft.rules} />
        </div>

        <div className="flex space-x-3">
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            onClick={() => void section.save()}
            disabled={saving || !valid || !dirty}
          >
            {saving ? "Saving..." : periodId ? "Update Period" : "Create Period"}
          </ViewOnlyActionButton>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function BookingPeriodsSection() {
  // Booking-policy config gates on the bookings area (its write route enforces
  // bookings:edit); a bookings:view admin sees it read-only (#1940).
  const canEdit = useAdminAreaEditAccess("bookings")
  // Per-lodge override scope (ADR-001 resolved question 3): null lists the
  // club-wide periods; a lodge lists its override set, which replaces the
  // club-wide set entirely at runtime. Hidden with fewer than two lodges.
  const [scopeLodgeId, setScopeLodgeId] = useState<string | null>(null)
  const scopeLodgeName = usePolicyScopeLodgeName(scopeLodgeId)
  const [periods, setPeriods] = useState<BookingPeriod[]>([])
  const [loadingPeriods, setLoadingPeriods] = useState(true)
  const [showPeriodForm, setShowPeriodForm] = useState(false)
  const [editingPeriodId, setEditingPeriodId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<PeriodDraft>(NEW_PERIOD_DRAFT)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const fetchPeriods = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(
        scopeLodgeId
          ? `/api/admin/booking-policies/periods?lodgeId=${encodeURIComponent(scopeLodgeId)}`
          : "/api/admin/booking-policies/periods",
        { signal }
      )
      if (!res.ok) throw new Error("Failed to fetch periods")
      const data = await res.json()
      setPeriods(
        data.map((period: BookingPeriod) => ({
          ...period,
          cancellationRules: period.cancellationRules.map((rule) => normalizeCancellationRule(rule)),
        }))
      )
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoadingPeriods(false)
    }
  }, [scopeLodgeId])

  useEffect(() => {
    const controller = new AbortController()
    fetchPeriods(controller.signal)
    return () => controller.abort()
  }, [fetchPeriods])

  function resetPeriodForm() {
    setShowPeriodForm(false)
    setEditingPeriodId(null)
    setEditingDraft(NEW_PERIOD_DRAFT)
  }

  function startAddPeriod() {
    setEditingPeriodId(null)
    setEditingDraft(NEW_PERIOD_DRAFT)
    setShowPeriodForm(true)
  }

  function startEditPeriod(period: BookingPeriod) {
    setEditingPeriodId(period.id)
    setEditingDraft(toDraft(period))
    setShowPeriodForm(true)
  }

  /**
   * The open editor's transport. Throws so `useSectionEditState` surfaces the
   * message; on success it closes the form and refreshes the list, which is why
   * the returned value (the hook's re-seed) is never actually rendered again.
   */
  const submitPeriod = useCallback(
    async (draft: PeriodDraft): Promise<PeriodDraft> => {
      setError("")
      setSuccess("")
      const url = editingPeriodId
        ? `/api/admin/booking-policies/periods/${editingPeriodId}`
        : "/api/admin/booking-policies/periods"
      const method = editingPeriodId ? "PUT" : "POST"

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          startDate: draft.startDate,
          endDate: draft.endDate,
          nonMemberHoldEnabled: draft.holdEnabled,
          nonMemberHoldDays: draft.holdDays,
          cancellationRules: draft.rules,
          // Partition is set at creation; edits keep the row's partition.
          ...(editingPeriodId ? {} : scopeLodgeId ? { lodgeId: scopeLodgeId } : {}),
        }),
      })
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError()
        const data = await res.json()
        throw new Error(data.error || "Failed to save period")
      }
      const saved = await res.json()
      // Parse the SERVER row into the re-seed value BEFORE closing the form, so
      // a malformed response surfaces as a save error rather than after a
      // success message has already been shown.
      const reseeded = toDraft({
        ...saved,
        cancellationRules: (saved.cancellationRules ?? draft.rules).map(
          (rule: PolicyRule) => normalizeCancellationRule(rule),
        ),
      })
      const wasEditing = editingPeriodId !== null
      resetPeriodForm()
      void fetchPeriods()
      setSuccess(wasEditing ? "Period updated" : "Period created")
      return reseeded
    },
    [editingPeriodId, scopeLodgeId, fetchPeriods],
  )

  async function handleDeletePeriod(id: string) {
    if (!confirm("Delete this booking period?")) return
    try {
      const res = await fetch(`/api/admin/booking-policies/periods/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to delete")
      fetchPeriods()
      setSuccess("Period deleted")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  async function handleTogglePeriod(period: BookingPeriod) {
    try {
      const res = await fetch(`/api/admin/booking-policies/periods/${period.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !period.active }),
      })
      if (!res.ok) throw new Error("Failed to update")
      fetchPeriods()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  if (loadingPeriods) {
    return <div className="text-center py-8">Loading...</div>
  }

  return (
    <div className="space-y-6">
      <PolicyFeedback
        error={error}
        success={success}
        onClearError={() => setError("")}
        onClearSuccess={() => setSuccess("")}
      />

      {/*
        #2142: the view-only explanation lives here, once, at the top of the
        section — announced on arrival and in the reading order — instead of on
        each disabled (and therefore unfocusable) button below.
      */}
      <AdminViewOnlySectionBanner canEdit={canEdit}>
        Your admin role can view booking periods but cannot change them.
        Bookings edit access is required.
      </AdminViewOnlySectionBanner>

      <PolicyScopeSelect
        value={scopeLodgeId}
        onChange={setScopeLodgeId}
        id="periods-scope"
      />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>
                {scopeLodgeName
                  ? `Date-Specific Periods — ${scopeLodgeName}`
                  : "Date-Specific Periods"}
              </CardTitle>
              <CardDescription>
                Override the default policy for specific date ranges (e.g. school holidays).
                If a booking&apos;s check-in falls within a period, that period&apos;s rules apply.
                {scopeLodgeName ? (
                  <>
                    {" "}
                    Periods listed here belong to {scopeLodgeName} and replace
                    the club-wide set for that lodge; if the list is empty the
                    lodge uses the club-wide periods.
                  </>
                ) : null}
              </CardDescription>
            </div>
            {!showPeriodForm && (
              <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={startAddPeriod}>Add Period</ViewOnlyActionButton>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Period Form — one `useSectionEditState` instance per open editor. */}
          {showPeriodForm && (
            <PeriodForm
              key={editingPeriodId ?? "new"}
              periodId={editingPeriodId}
              initial={editingDraft}
              canEdit={canEdit}
              onSubmit={submitPeriod}
              onCancel={resetPeriodForm}
              onError={setError}
            />
          )}

          {/* Periods List */}
          {periods.length === 0 && !showPeriodForm ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No date-specific periods configured. The default policy applies to all bookings.
            </p>
          ) : (
            <div className="space-y-3">
              {periods.map((period) => (
                <Card key={period.id} className={!period.active ? "opacity-60" : ""}>
                  <CardContent className="pt-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-semibold">{period.name}</h4>
                          <Badge variant={period.active ? "default" : "outline"}>
                            {period.active ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {new Date(period.startDate).toLocaleDateString("en-NZ")} &mdash;{" "}
                          {new Date(period.endDate).toLocaleDateString("en-NZ")}
                          <span className="ml-3">
                            Non-member hold:{" "}
                            <strong>
                              {period.nonMemberHoldEnabled ?? true
                                ? `${period.nonMemberHoldDays} days`
                                : "First Paid, First In"}
                            </strong>
                          </span>
                        </p>
                      </div>
                      <div className="flex space-x-2">
                        <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => handleTogglePeriod(period)}>
                          {period.active ? "Deactivate" : "Activate"}
                        </ViewOnlyActionButton>
                        <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => startEditPeriod(period)}>
                          Edit
                        </ViewOnlyActionButton>
                        <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="destructive" size="sm" onClick={() => handleDeletePeriod(period.id)}>
                          Delete
                        </ViewOnlyActionButton>
                      </div>
                    </div>
                    <PolicyPreview rules={period.cancellationRules} />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
