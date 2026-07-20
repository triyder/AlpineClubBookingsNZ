"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
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
import { DAY_LABELS, type MinStayPolicy } from "./types"

/**
 * One open minimum-stay editor's draft. Like the booking-periods section, the
 * section's own snapshot is a LIST, so the draft/snapshot pair that
 * `useSectionEditState` owns is scoped to the ROW being edited: the form below
 * mounts one hook instance per open editor, keyed on the row id.
 */
interface MinStayDraft {
  name: string
  startDate: string
  endDate: string
  triggerDays: number[]
  minimumNights: number
}

const NEW_MIN_STAY_DRAFT: MinStayDraft = {
  name: "",
  startDate: "",
  endDate: "",
  triggerDays: [6], // default Saturday
  minimumNights: 2,
}

function toDraft(policy: MinStayPolicy): MinStayDraft {
  return {
    name: policy.name,
    startDate: policy.startDate.split("T")[0],
    endDate: policy.endDate.split("T")[0],
    triggerDays: [...policy.triggerDays].sort((a, b) => a - b),
    minimumNights: policy.minimumNights,
  }
}

function draftsEqual(a: MinStayDraft, b: MinStayDraft) {
  return (
    a.name === b.name &&
    a.startDate === b.startDate &&
    a.endDate === b.endDate &&
    a.minimumNights === b.minimumNights &&
    // Both sides are kept sorted ascending, so index-wise comparison is a set
    // comparison here — ticking a day and unticking it again is not a change.
    a.triggerDays.length === b.triggerDays.length &&
    a.triggerDays.every((day, i) => day === b.triggerDays[i])
  )
}

function MinStayForm({
  policyId,
  initial,
  canEdit,
  onSubmit,
  onCancel,
  onError,
}: {
  /** `null` while creating — there is no persisted row to be unchanged from. */
  policyId: string | null
  initial: MinStayDraft
  canEdit: boolean | undefined
  /** Persists the draft and closes the form. Throws to surface a failure. */
  onSubmit: (draft: MinStayDraft) => Promise<MinStayDraft>
  onCancel: () => void
  onError: (message: string) => void
}) {
  const section = useSectionEditState<MinStayDraft>({
    initial,
    save: onSubmit,
    // The section renders its own `PolicyFeedback` above the list, so the
    // success copy is set by the parent when the form closes.
    successMessage: "",
    // #2143: an Edit -> Save that changed nothing must not reach the PUT, which
    // logs and revalidates unconditionally. Creating is the first-save
    // exception: there is no persisted row for the draft to be unchanged FROM.
    isDirty: (draft, saved) => policyId === null || !draftsEqual(draft, saved),
    isValid: (draft) =>
      Boolean(draft.name) &&
      Boolean(draft.startDate) &&
      Boolean(draft.endDate) &&
      draft.triggerDays.length > 0,
  })

  const { draft, saving, dirty, valid, error } = section

  // The hook owns the save-failure message; this section presents every message
  // in one place above the list, so mirror it up rather than rendering twice.
  useEffect(() => {
    if (error) onError(error)
  }, [error, onError])

  if (!draft) return null

  function toggleTriggerDay(day: number) {
    section.setDraft((current) => ({
      ...current,
      triggerDays: current.triggerDays.includes(day)
        ? current.triggerDays.filter((d) => d !== day)
        : [...current.triggerDays, day].sort((a, b) => a - b),
    }))
  }

  return (
    <Card className="border-blue-200 bg-blue-50/30">
      <CardContent className="pt-6 space-y-4">
        <h3 className="font-semibold">
          {policyId ? "Edit Policy" : "New Minimum Stay Policy"}
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="msName">Policy Name</Label>
            <Input
              id="msName"
              value={draft.name}
              onChange={(e) => section.setDraft({ name: e.target.value })}
              placeholder="e.g. Winter Saturday Minimum Stay"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="msMinNights">Minimum Nights</Label>
            <Input
              id="msMinNights"
              type="number"
              min="2"
              value={draft.minimumNights}
              onChange={(e) =>
                section.setDraft({ minimumNights: parseInt(e.target.value) || 2 })
              }
              className="w-24"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="msStart">Start Date</Label>
            <Input
              id="msStart"
              type="date"
              value={draft.startDate}
              onChange={(e) => section.setDraft({ startDate: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="msEnd">End Date</Label>
            <Input
              id="msEnd"
              type="date"
              value={draft.endDate}
              onChange={(e) => section.setDraft({ endDate: e.target.value })}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-semibold">Trigger Days</Label>
          <p className="text-xs text-muted-foreground">
            The minimum stay applies when a booking includes any of these days within the date range.
          </p>
          <div className="flex flex-wrap gap-3">
            {DAY_LABELS.map((label, i) => (
              <label key={i} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={draft.triggerDays.includes(i)}
                  onCheckedChange={() => toggleTriggerDay(i)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div className="flex space-x-3">
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            onClick={() => void section.save()}
            disabled={saving || !valid || !dirty}
          >
            {saving ? "Saving..." : policyId ? "Update Policy" : "Create Policy"}
          </ViewOnlyActionButton>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function MinimumNightStaySection() {
  // Booking-policy config gates on the bookings area (its write route enforces
  // bookings:edit); a bookings:view admin sees it read-only (#1940).
  const canEdit = useAdminAreaEditAccess("bookings")
  // Per-lodge override scope (ADR-001 resolved question 3): null lists the
  // club-wide policies; a lodge lists its override set, which replaces the
  // club-wide set entirely at runtime. Hidden with fewer than two lodges.
  const [scopeLodgeId, setScopeLodgeId] = useState<string | null>(null)
  const scopeLodgeName = usePolicyScopeLodgeName(scopeLodgeId)
  const [minStayPolicies, setMinStayPolicies] = useState<MinStayPolicy[]>([])
  const [loadingMinStay, setLoadingMinStay] = useState(true)
  const [showMinStayForm, setShowMinStayForm] = useState(false)
  const [editingMinStayId, setEditingMinStayId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<MinStayDraft>(NEW_MIN_STAY_DRAFT)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const fetchMinStay = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(
        scopeLodgeId
          ? `/api/admin/booking-policies/minimum-stay?lodgeId=${encodeURIComponent(scopeLodgeId)}`
          : "/api/admin/booking-policies/minimum-stay",
        { signal }
      )
      if (!res.ok) throw new Error("Failed to fetch minimum stay policies")
      const data = await res.json()
      setMinStayPolicies(data)
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoadingMinStay(false)
    }
  }, [scopeLodgeId])

  useEffect(() => {
    const controller = new AbortController()
    fetchMinStay(controller.signal)
    return () => controller.abort()
  }, [fetchMinStay])

  function resetMinStayForm() {
    setShowMinStayForm(false)
    setEditingMinStayId(null)
    setEditingDraft(NEW_MIN_STAY_DRAFT)
  }

  function startAddMinStay() {
    setEditingMinStayId(null)
    setEditingDraft(NEW_MIN_STAY_DRAFT)
    setShowMinStayForm(true)
  }

  function startEditMinStay(policy: MinStayPolicy) {
    setEditingMinStayId(policy.id)
    setEditingDraft(toDraft(policy))
    setShowMinStayForm(true)
  }

  /**
   * The open editor's transport. Throws so `useSectionEditState` surfaces the
   * message; on success it closes the form and refreshes the list, which is why
   * the returned value (the hook's re-seed) is never actually rendered again.
   */
  const submitMinStay = useCallback(
    async (draft: MinStayDraft): Promise<MinStayDraft> => {
      setError("")
      setSuccess("")
      const url = editingMinStayId
        ? `/api/admin/booking-policies/minimum-stay/${editingMinStayId}`
        : "/api/admin/booking-policies/minimum-stay"
      const method = editingMinStayId ? "PUT" : "POST"

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          startDate: draft.startDate,
          endDate: draft.endDate,
          triggerDays: draft.triggerDays,
          minimumNights: draft.minimumNights,
          // Partition is set at creation; edits keep the row's partition.
          ...(editingMinStayId ? {} : scopeLodgeId ? { lodgeId: scopeLodgeId } : {}),
        }),
      })
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError()
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      const saved = await res.json()
      // Parse the SERVER row into the re-seed value BEFORE closing the form, so
      // a malformed response surfaces as a save error rather than after a
      // success message has already been shown.
      const reseeded = toDraft({
        ...saved,
        triggerDays: saved.triggerDays ?? draft.triggerDays,
      })
      const wasEditing = editingMinStayId !== null
      resetMinStayForm()
      void fetchMinStay()
      setSuccess(
        wasEditing ? "Minimum stay policy updated" : "Minimum stay policy created",
      )
      return reseeded
    },
    [editingMinStayId, scopeLodgeId, fetchMinStay],
  )

  async function handleDeleteMinStay(id: string) {
    if (!confirm("Deactivate this minimum stay policy?")) return
    try {
      const res = await fetch(`/api/admin/booking-policies/minimum-stay/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to deactivate")
      fetchMinStay()
      setSuccess("Minimum stay policy deactivated")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  async function handleToggleMinStay(policy: MinStayPolicy) {
    try {
      const res = await fetch(`/api/admin/booking-policies/minimum-stay/${policy.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !policy.active }),
      })
      if (!res.ok) throw new Error("Failed to update")
      fetchMinStay()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  if (loadingMinStay) {
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
        Your admin role can view minimum-stay policies but cannot change them.
        Bookings edit access is required.
      </AdminViewOnlySectionBanner>

      <PolicyScopeSelect
        value={scopeLodgeId}
        onChange={setScopeLodgeId}
        id="min-stay-scope"
      />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>
                {scopeLodgeName
                  ? `Minimum Night Stay — ${scopeLodgeName}`
                  : "Minimum Night Stay"}
              </CardTitle>
              <CardDescription>
                Require a minimum number of nights when a booking touches specific days of the week
                within a date range. Admins can override these rules.
                {scopeLodgeName ? (
                  <>
                    {" "}
                    Policies listed here belong to {scopeLodgeName} and replace
                    the club-wide set for that lodge; if the list is empty the
                    lodge uses the club-wide policies.
                  </>
                ) : null}
              </CardDescription>
            </div>
            {!showMinStayForm && (
              <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={startAddMinStay}>Add Policy</ViewOnlyActionButton>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Min Stay Form — one `useSectionEditState` instance per open editor. */}
          {showMinStayForm && (
            <MinStayForm
              key={editingMinStayId ?? "new"}
              policyId={editingMinStayId}
              initial={editingDraft}
              canEdit={canEdit}
              onSubmit={submitMinStay}
              onCancel={resetMinStayForm}
              onError={setError}
            />
          )}

          {/* Min Stay List */}
          {minStayPolicies.length === 0 && !showMinStayForm ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No minimum night stay policies configured. Members can book any number of nights.
            </p>
          ) : (
            <div className="space-y-3">
              {minStayPolicies.map((policy) => (
                <Card key={policy.id} className={!policy.active ? "opacity-60" : ""}>
                  <CardContent className="pt-4">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-semibold">{policy.name}</h4>
                          <Badge variant={policy.active ? "default" : "outline"}>
                            {policy.active ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {new Date(policy.startDate).toLocaleDateString("en-NZ")} &mdash;{" "}
                          {new Date(policy.endDate).toLocaleDateString("en-NZ")}
                        </p>
                      </div>
                      <div className="flex space-x-2">
                        <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => handleToggleMinStay(policy)}>
                          {policy.active ? "Deactivate" : "Activate"}
                        </ViewOnlyActionButton>
                        <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => startEditMinStay(policy)}>
                          Edit
                        </ViewOnlyActionButton>
                        {policy.active && (
                          <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="destructive" size="sm" onClick={() => handleDeleteMinStay(policy.id)}>
                            Deactivate
                          </ViewOnlyActionButton>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Trigger days:</span>
                      {policy.triggerDays.map((d) => (
                        <Badge key={d} variant="secondary">{DAY_LABELS[d]}</Badge>
                      ))}
                      <span className="ml-2 text-muted-foreground">
                        Min <strong>{policy.minimumNights}</strong> nights
                      </span>
                    </div>
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
