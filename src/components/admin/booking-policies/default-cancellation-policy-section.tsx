"use client"

import { useEffect, useState, useCallback } from "react"
import { normalizeCancellationRule } from "@/lib/cancellation-rules"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CancellationRulesEditor } from "./cancellation-rules-editor"
import { PolicyPreview } from "./policy-preview"
import { PolicyFeedback } from "./policy-feedback"
import { PolicyScopeSelect, usePolicyScopeLodgeName } from "./policy-scope-select"
import { useLodgeOptions } from "@/components/lodge-select"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import type { PolicyRule } from "./types"

type WaitlistCrossLodgeOrder = "OWN_LODGE_FIRST" | "MERGED"

const FALLBACK_RULES: PolicyRule[] = [
  { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0, creditFixedFeeCents: 0 },
  { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0, creditFixedFeeCents: 0 },
  { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0, creditFixedFeeCents: 0 },
]

async function fetchPartition(lodgeId: string | null): Promise<{
  rules: PolicyRule[]
  nonMemberHoldDays: number
}> {
  const res = await fetch(
    lodgeId
      ? `/api/admin/booking-policies/cancellation?lodgeId=${encodeURIComponent(lodgeId)}`
      : "/api/admin/booking-policies/cancellation",
  )
  if (!res.ok) throw new Error("Failed to fetch policy")
  const data = await res.json()
  return {
    rules: (data.rules ?? []).map((r: PolicyRule) => normalizeCancellationRule(r)),
    nonMemberHoldDays: data.nonMemberHoldDays ?? 7,
  }
}

export function DefaultCancellationPolicySection() {
  // Per-lodge override scope (ADR-001 resolved question 3): null edits the
  // club-wide rules; a lodge edits that lodge's override set, which replaces
  // the club-wide set entirely at runtime. The scope control renders nothing
  // while fewer than two lodges exist.
  const [scopeLodgeId, setScopeLodgeId] = useState<string | null>(null)
  const scopeLodgeName = usePolicyScopeLodgeName(scopeLodgeId)
  const [hasOverride, setHasOverride] = useState(false)
  const [defaultRules, setDefaultRules] = useState<PolicyRule[]>([])
  const [defaultHoldEnabled, setDefaultHoldEnabled] = useState(true)
  const [defaultHoldDays, setDefaultHoldDays] = useState(7)
  // Cross-lodge waitlist queue order (ADR-004): club-wide, only rendered
  // when a second lodge exists.
  const [defaultWaitlistOrder, setDefaultWaitlistOrder] =
    useState<WaitlistCrossLodgeOrder>("OWN_LODGE_FIRST")
  const { lodges } = useLodgeOptions("admin")
  const [loadingDefaults, setLoadingDefaults] = useState(true)
  const [savingDefaults, setSavingDefaults] = useState(false)
  const [editingDefaults, setEditingDefaults] = useState(false)
  const [savedDefaultRules, setSavedDefaultRules] = useState<PolicyRule[]>([])
  const [savedDefaultHoldEnabled, setSavedDefaultHoldEnabled] = useState(true)
  const [savedDefaultHoldDays, setSavedDefaultHoldDays] = useState(7)
  const [savedDefaultWaitlistOrder, setSavedDefaultWaitlistOrder] =
    useState<WaitlistCrossLodgeOrder>("OWN_LODGE_FIRST")
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  // Booking-policy config gates on the bookings area (its write route enforces
  // bookings:edit); a bookings:view admin sees it read-only (#1940).
  const canEdit = useAdminAreaEditAccess("bookings")

  const fetchDefaults = useCallback(async (signal?: AbortSignal) => {
    setLoadingDefaults(true)
    try {
      const res = await fetch(
        scopeLodgeId
          ? `/api/admin/booking-policies/cancellation?lodgeId=${encodeURIComponent(scopeLodgeId)}`
          : "/api/admin/booking-policies/cancellation",
        { signal },
      )
      if (!res.ok) throw new Error("Failed to fetch policy")
      const data = await res.json()
      const fetchedRules: PolicyRule[] = (data.rules ?? []).map(
        (r: PolicyRule) => normalizeCancellationRule(r),
      )
      // Club-wide with no rows yet gets a sensible editable starting point.
      // A lodge with no rows has NO override — seeding defaults here would
      // invite accidentally creating one, so keep the list empty instead.
      const rules =
        fetchedRules.length > 0 || scopeLodgeId ? fetchedRules : FALLBACK_RULES
      const holdEnabled = data.nonMemberHoldEnabled ?? true
      const holdDays = data.nonMemberHoldDays ?? 7
      const waitlistOrder: WaitlistCrossLodgeOrder =
        data.waitlistCrossLodgeOrder === "MERGED" ? "MERGED" : "OWN_LODGE_FIRST"
      setHasOverride(Boolean(scopeLodgeId) && fetchedRules.length > 0)
      setDefaultRules(rules)
      setDefaultHoldEnabled(holdEnabled)
      setDefaultHoldDays(holdDays)
      setDefaultWaitlistOrder(waitlistOrder)
      setSavedDefaultRules(rules)
      setSavedDefaultHoldEnabled(holdEnabled)
      setSavedDefaultHoldDays(holdDays)
      setSavedDefaultWaitlistOrder(waitlistOrder)
      setEditingDefaults(false)
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoadingDefaults(false)
    }
  }, [scopeLodgeId])

  useEffect(() => {
    const controller = new AbortController()
    fetchDefaults(controller.signal)
    return () => controller.abort()
  }, [fetchDefaults])

  function handleCancelDefaults() {
    setDefaultRules(savedDefaultRules)
    setDefaultHoldEnabled(savedDefaultHoldEnabled)
    setDefaultHoldDays(savedDefaultHoldDays)
    setDefaultWaitlistOrder(savedDefaultWaitlistOrder)
    setEditingDefaults(false)
    // Cancelling an unsaved "create override" must also drop the optimistic
    // override state; a refetch restores whatever the server actually holds.
    if (scopeLodgeId && savedDefaultRules.length === 0) {
      void fetchDefaults()
    }
  }

  async function saveRules(rules: PolicyRule[], successMessage: string) {
    setSavingDefaults(true)
    setError("")
    setSuccess("")
    try {
      const res = await fetch("/api/admin/booking-policies/cancellation", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules,
          // Hold enablement, hold days, and waitlist queue order are club-wide;
          // only the club-wide scope edits them.
          ...(scopeLodgeId
            ? { lodgeId: scopeLodgeId }
            : {
                nonMemberHoldEnabled: defaultHoldEnabled,
                nonMemberHoldDays: defaultHoldDays,
                waitlistCrossLodgeOrder: defaultWaitlistOrder,
              }),
        }),
      })
      if (!res.ok) {
        if (res.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON)
          return
        }
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      await fetchDefaults()
      setSuccess(successMessage)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSavingDefaults(false)
    }
  }

  async function handleSaveDefaults() {
    await saveRules(
      defaultRules,
      scopeLodgeId ? `Override saved for ${scopeLodgeName ?? "lodge"}` : "Default policy saved",
    )
  }

  async function handleCreateOverride() {
    setError("")
    setSuccess("")
    try {
      // Seed the editor from the club-wide rules so the override starts as
      // a copy the admin adjusts, not a blank slate.
      const clubWide = await fetchPartition(null)
      setDefaultRules(clubWide.rules.length > 0 ? clubWide.rules : FALLBACK_RULES)
      setHasOverride(true)
      setEditingDefaults(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  async function handleRemoveOverride() {
    if (
      !window.confirm(
        `Remove ${scopeLodgeName ?? "this lodge"}'s cancellation rules? Bookings there will use the club-wide rules again.`,
      )
    ) {
      return
    }
    await saveRules([], "Override removed — this lodge uses the club-wide rules")
  }

  if (loadingDefaults) {
    return <div className="text-center py-8">Loading...</div>
  }

  const scopeIsLodge = scopeLodgeId !== null
  const showEditor = !scopeIsLodge || hasOverride

  return (
    <div className="space-y-6">
      <PolicyFeedback
        error={error}
        success={success}
        onClearError={() => setError("")}
        onClearSuccess={() => setSuccess("")}
      />

      <PolicyScopeSelect value={scopeLodgeId} onChange={setScopeLodgeId} />

      {!canEdit ? (
        <AdminViewOnlyNotice>
          Your admin role can view the cancellation policy but cannot change it.
          Bookings edit access is required.
        </AdminViewOnlyNotice>
      ) : null}

      {scopeIsLodge && !hasOverride ? (
        <Card>
          <CardHeader>
            <CardTitle>{scopeLodgeName ?? "Lodge"} uses the club-wide rules</CardTitle>
            <CardDescription>
              No override exists for this lodge, so cancellations here follow
              the club-wide policy. An override replaces the club-wide rules
              entirely for this lodge.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ViewOnlyActionButton canEdit={canEdit} onClick={() => void handleCreateOverride()}>
              Create override for this lodge
            </ViewOnlyActionButton>
          </CardContent>
        </Card>
      ) : null}

      {showEditor ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>
                {scopeIsLodge
                  ? `${scopeLodgeName ?? "Lodge"} Override`
                  : "Default Policy"}
              </CardTitle>
              <CardDescription>
                {scopeIsLodge
                  ? "These rules replace the club-wide rules for bookings at this lodge."
                  : "These rules apply to all bookings unless a date-specific period overrides them."}
              </CardDescription>
            </div>
            {!editingDefaults && (
              <ViewOnlyActionButton canEdit={canEdit} variant="outline" size="sm" onClick={() => setEditingDefaults(true)}>
                Edit
              </ViewOnlyActionButton>
            )}
          </CardHeader>
          <CardContent className="space-y-6">
            {!scopeIsLodge ? (
              <div className="space-y-4 max-w-md">
                <div className="flex items-start gap-3 rounded-md border p-3">
                  <Checkbox
                    id="nonMemberHoldEnabled"
                    checked={defaultHoldEnabled}
                    disabled={!editingDefaults}
                    onCheckedChange={(v) => setDefaultHoldEnabled(v === true)}
                  />
                  <div className="space-y-1">
                    <Label htmlFor="nonMemberHoldEnabled">Members First booking policy</Label>
                    <p className="text-xs text-muted-foreground">
                      When enabled, non-member guests outside the threshold are held provisionally.
                      When disabled, mixed member and non-member bookings proceed as First Paid, First In.
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="holdDays">Non-member confirmation threshold</Label>
                  <div className="flex items-center space-x-2">
                    <Input
                      id="holdDays"
                      type="number"
                      min="1"
                      max="365"
                      value={defaultHoldDays}
                      onChange={(e) => setDefaultHoldDays(parseInt(e.target.value) || 7)}
                      className={`w-20 ${!editingDefaults || !defaultHoldEnabled ? "bg-slate-50 text-slate-700" : ""}`}
                      disabled={!editingDefaults || !defaultHoldEnabled}
                    />
                    <span className="text-sm text-muted-foreground">days before check-in</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {defaultHoldEnabled
                      ? "Non-member bookings are held as pending until this many days before check-in, then confirmed automatically."
                      : "The threshold is retained but inactive while First Paid, First In is selected."}
                  </p>
                </div>
              </div>
            ) : null}

            {!scopeIsLodge && lodges.length > 1 ? (
              <div className="space-y-2 max-w-md">
                <Label htmlFor="waitlistOrder">Cross-lodge waitlist queue order</Label>
                <select
                  id="waitlistOrder"
                  value={defaultWaitlistOrder}
                  onChange={(e) =>
                    setDefaultWaitlistOrder(e.target.value as WaitlistCrossLodgeOrder)
                  }
                  disabled={!editingDefaults}
                  className={`w-full rounded-md border border-input px-3 py-2 text-sm ${!editingDefaults ? "bg-slate-50 text-slate-700" : "bg-background"}`}
                >
                  <option value="OWN_LODGE_FIRST">
                    Own lodge first — a lodge&apos;s own waitlist is served before cross-lodge opt-ins
                  </option>
                  <option value="MERGED">
                    Merged — everyone eligible is ranked purely by when they joined
                  </option>
                </select>
                <p className="text-xs text-muted-foreground">
                  When a spot frees up at a lodge, this decides whether members
                  waitlisted at that lodge are always served before members from
                  another lodge&apos;s waitlist who opted in to accept it.
                </p>
              </div>
            ) : null}

            <div>
              <Label className="text-base font-semibold">Cancellation Refund Rules</Label>
              <p className="text-sm text-muted-foreground mb-3">
                The first matching rule (highest days threshold) applies.
              </p>
              <CancellationRulesEditor rules={defaultRules} onChange={setDefaultRules} disabled={!editingDefaults} />
            </div>

            <div>
              <Label className="text-sm font-semibold">Preview</Label>
              <PolicyPreview rules={defaultRules} />
            </div>

            {editingDefaults && (
              <div className="flex flex-wrap gap-3">
                <Button onClick={handleSaveDefaults} disabled={savingDefaults}>
                  {savingDefaults
                    ? "Saving..."
                    : scopeIsLodge
                      ? "Save Lodge Override"
                      : "Save Default Policy"}
                </Button>
                <Button variant="outline" onClick={handleCancelDefaults} disabled={savingDefaults}>
                  Cancel
                </Button>
              </div>
            )}
            {scopeIsLodge && hasOverride && !editingDefaults ? (
              <ViewOnlyActionButton
                canEdit={canEdit}
                variant="outline"
                onClick={() => void handleRemoveOverride()}
                disabled={savingDefaults}
              >
                Remove override (use club-wide rules)
              </ViewOnlyActionButton>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
