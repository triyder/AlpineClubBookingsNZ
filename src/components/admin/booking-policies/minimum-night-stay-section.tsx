"use client"

import { useEffect, useRef, useState, useCallback } from "react"
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

/**
 * The scope of a list that was never loaded (#2142 review). Club-wide scope is
 * `null`, so `null` cannot double as "unknown" — see the identical sentinel in
 * `default-cancellation-policy-section.tsx`.
 */
const UNLOADED_SCOPE = "__unloaded__"

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
  /**
   * The scope `minStayPolicies` was actually loaded FOR (#2142 review).
   *
   * `AGENTS.md` makes this binding for any section whose fetch is keyed on
   * something beyond the section itself: the key travels WITH the snapshot and a
   * mismatch is UNKNOWN — no editor, no destructive affordances. A failed fetch
   * here used to set `error` and leave the list alone, so after a failed switch
   * to a lodge the card was retitled "Minimum Night Stay — Lodge One", said
   * "Policies listed here belong to Lodge One", and left Edit, Delete and
   * Activate/Deactivate live over rows that were still the CLUB-WIDE set. Every
   * one of those buttons acts on `policy.id`, so they would have hit the
   * club-wide rows the admin believed they had navigated away from.
   */
  const [loadedScope, setLoadedScope] = useState<string | null>(UNLOADED_SCOPE)
  // Mirrors `scopeLodgeId` for the async fetch below, which needs the CURRENT
  // scope at the moment it resolves rather than the one it closed over. The
  // list refresh after a save/delete/toggle carries no AbortSignal, so this is
  // the only thing standing between a slow response and the wrong partition.
  const scopeRef = useRef(scopeLodgeId)
  const [loadingMinStay, setLoadingMinStay] = useState(true)
  const [showMinStayForm, setShowMinStayForm] = useState(false)
  const [editingMinStayId, setEditingMinStayId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<MinStayDraft>(NEW_MIN_STAY_DRAFT)
  // Bumped every time an editor is opened. The open editor owns its own
  // draft/snapshot pair, seeded once from `initial`, so re-opening the SAME row
  // has to remount it — otherwise `key={editingMinStayId ?? "new"}` is
  // unchanged, React reuses the instance, the new `initial` is ignored, and
  // clicking Edit again on a row you were already editing silently keeps the
  // unsaved draft instead of resetting the form (#2142 review).
  const [editorInstance, setEditorInstance] = useState(0)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  /**
   * Load the list for the CURRENT scope.
   *
   * `scopeLoad` marks the fetch that a scope change (including the mount) is
   * waiting on: only that one flips the section into its loading state, so an
   * ordinary refresh after a write never blanks the list. Every state write is
   * guarded on the scope still being the one this call was made for, which is
   * also what keeps `loadedScope` honest — a dropped response leaves the new
   * scope UNKNOWN until its own load lands, rather than labelling one scope's
   * rows with another's.
   */
  const fetchMinStay = useCallback(
    async (options: { signal?: AbortSignal; scopeLoad?: boolean } = {}) => {
      const { signal, scopeLoad = false } = options
      const scope = scopeLodgeId
      if (scopeLoad) setLoadingMinStay(true)
      try {
        const res = await fetch(
          scope
            ? `/api/admin/booking-policies/minimum-stay?lodgeId=${encodeURIComponent(scope)}`
            : "/api/admin/booking-policies/minimum-stay",
          { signal }
        )
        if (!res.ok) throw new Error("Failed to fetch minimum stay policies")
        const data = await res.json()
        if (scopeRef.current !== scope) return
        setMinStayPolicies(data)
        setLoadedScope(scope)
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return
        if (scopeRef.current !== scope) return
        setError(err instanceof Error ? err.message : "Unknown error")
      } finally {
        if (scopeLoad && scopeRef.current === scope) setLoadingMinStay(false)
      }
    },
    [scopeLodgeId],
  )

  useEffect(() => {
    scopeRef.current = scopeLodgeId
    // An open editor belongs to the partition we are leaving, so a scope change
    // closes it. Its row id would otherwise stay pointed at the old partition.
    setShowMinStayForm(false)
    setEditingMinStayId(null)
    setEditingDraft(NEW_MIN_STAY_DRAFT)
    const controller = new AbortController()
    void fetchMinStay({ signal: controller.signal, scopeLoad: true })
    return () => controller.abort()
  }, [fetchMinStay, scopeLodgeId])

  function resetMinStayForm() {
    setShowMinStayForm(false)
    setEditingMinStayId(null)
    setEditingDraft(NEW_MIN_STAY_DRAFT)
  }

  /** Close the open editor and clear the message it mirrored up (#2142 review). */
  function cancelMinStayForm() {
    setError("")
    resetMinStayForm()
  }

  function startAddMinStay() {
    setEditingMinStayId(null)
    setEditingDraft(NEW_MIN_STAY_DRAFT)
    setEditorInstance((n) => n + 1)
    setShowMinStayForm(true)
  }

  function startEditMinStay(policy: MinStayPolicy) {
    setEditingMinStayId(policy.id)
    setEditingDraft(toDraft(policy))
    setEditorInstance((n) => n + 1)
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
      const wasEditing = editingMinStayId !== null
      // Parse the SERVER row into the re-seed value BEFORE closing the form, so
      // a malformed response surfaces as a save error rather than after a
      // success message has already been shown.
      let reseeded: MinStayDraft
      try {
        const saved = await res.json()
        reseeded = toDraft({
          ...saved,
          triggerDays: saved.triggerDays ?? draft.triggerDays,
        })
      } catch {
        // The write ALREADY SUCCEEDED at this point, so what a parse failure
        // may safely do depends on the verb. An edit is an idempotent PUT: keep
        // the form open with the error and the natural retry re-writes the same
        // row. A create is not: the row exists, but the form still has
        // `policyId === null`, so the same retry would POST a SECOND row. There
        // we swallow the parse failure, fall back to the submitted draft, and
        // close the form — the list refresh below shows what was really stored.
        if (wasEditing) {
          throw new Error(
            "The policy was saved, but the server's reply could not be read. Reload the page to see what is stored.",
          )
        }
        reseeded = draft
      }
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
    if (
      !confirm(
        "Delete this minimum stay policy? It stops applying immediately and stays listed as inactive, so the change is auditable.",
      )
    ) {
      return
    }
    try {
      const res = await fetch(`/api/admin/booking-policies/minimum-stay/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to deactivate")
      fetchMinStay()
      setSuccess("Minimum stay policy deleted — it is listed as inactive")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  /**
   * #2143, second route in: Activate/Deactivate is a direct write, and it read
   * `policy.active` from a row that only changes once the refresh below
   * resolves. Two quick clicks therefore both saw `active: true` and both sent
   * `{ active: false }` — the second PUT writing a `minimum-stay-policy.update`
   * entry whose `before` and `after` are identical AND busting the public-page
   * cache, which is exactly the harm the Save dirty gate exists to stop,
   * reachable by one admin with an impatient double-click and no concurrency.
   *
   * The ref is the real guard: it is set synchronously, so a genuine
   * double-click dispatched inside one tick — where both handlers close over the
   * same pre-update state — still only fires once. `togglingId` is the visible
   * half, disabling the button for the round trip, and the refresh is awaited so
   * it stays disabled until the row it re-reads is on screen.
   */
  const togglingRef = useRef(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  async function handleToggleMinStay(policy: MinStayPolicy) {
    if (togglingRef.current) return
    togglingRef.current = true
    setTogglingId(policy.id)
    try {
      const res = await fetch(`/api/admin/booking-policies/minimum-stay/${policy.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !policy.active }),
      })
      if (!res.ok) throw new Error("Failed to update")
      await fetchMinStay()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      togglingRef.current = false
      setTogglingId(null)
    }
  }

  /** Re-run the current scope's load in place, without leaving the section. */
  function retryLoad() {
    setError("")
    void fetchMinStay({ scopeLoad: true })
  }

  /*
    #2142: the view-only explanation lives here, once, at the top of the
    section — announced on arrival and in the reading order — instead of on each
    disabled button below. It is rendered in every state below, in the same
    position, so the polite live region is registered in the accessibility tree
    from the first paint and only its CONTENT changes when `canEdit` resolves. A
    region injected already-populated is silently dropped by some
    screen-reader/browser pairings.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view minimum-stay policies but cannot change them.
      Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  )

  // See `loadedScope`: the list is authoritative only for the scope it was
  // loaded for, and anything else is unknown rather than editable.
  const scopeKnown = loadedScope === scopeLodgeId

  /*
    #2142 review (round 4): there is deliberately NO early return for the
    loading state — see the identical note in `booking-periods-section.tsx`.
    A scope change is a `scopeLoad`, so an early return unmounted
    `PolicyScopeSelect` (dropping the keyboard user's focus to `<body>` for the
    whole round trip) and pushed `PolicyFeedback` below it, so a failed FIRST
    load mounted its live regions already populated. The frame — banner,
    feedback, scope select — is rendered in every state; loading replaces only
    the list card.
  */
  return (
    <div>
      {viewOnlyBanner}
      <PolicyFeedback
        error={error}
        success={success}
        onClearError={() => setError("")}
        onClearSuccess={() => setSuccess("")}
      />
      <div className="space-y-6">
        <PolicyScopeSelect
          value={scopeLodgeId}
          onChange={setScopeLodgeId}
          id="min-stay-scope"
        />

        {loadingMinStay ? (
          <div className="text-center py-8">Loading...</div>
        ) : null}

        {!loadingMinStay && !scopeKnown ? (
          <Card>
            <CardHeader>
              <CardTitle>
                Could not load the minimum-stay policies for{" "}
                {scopeLodgeName ?? "the club"}
              </CardTitle>
              <CardDescription>
                Nothing is listed, because we do not know what is stored here.
                The policies that were on screen a moment ago belong to a
                different scope, so editing, deleting, or deactivating them from
                here would change the wrong thing. Try again below — the list
                returns as soon as it loads.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={retryLoad}>
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {!loadingMinStay && scopeKnown ? (
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
                  key={`${editingMinStayId ?? "new"}:${editorInstance}`}
                  policyId={editingMinStayId}
                  initial={editingDraft}
                  canEdit={canEdit}
                  onSubmit={submitMinStay}
                  onCancel={cancelMinStayForm}
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
                            <ViewOnlyActionButton
                              canEdit={canEdit}
                              describeReason={false}
                              variant="outline"
                              size="sm"
                              disabled={togglingId === policy.id}
                              onClick={() => void handleToggleMinStay(policy)}
                            >
                              {policy.active ? "Deactivate" : "Activate"}
                            </ViewOnlyActionButton>
                            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => startEditMinStay(policy)}>
                              Edit
                            </ViewOnlyActionButton>
                            {/*
                              #2142 review: this used to read "Deactivate" too,
                              so an active row offered two differently-styled
                              buttons with the same label and no way to tell them
                              apart. They are genuinely different actions — the
                              outline one is the reversible Active/Inactive
                              toggle, this one is the delete, implemented as a
                              soft delete (`active: false`) purely so the audit
                              history survives, and recorded as
                              `minimum-stay-policy.delete`. The label now names
                              the action; the confirm and the success copy below
                              say what a soft delete actually leaves behind.
                            */}
                            {policy.active && (
                              <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="destructive" size="sm" onClick={() => handleDeleteMinStay(policy.id)}>
                                Delete
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
        ) : null}
      </div>
    </div>
  )
}
