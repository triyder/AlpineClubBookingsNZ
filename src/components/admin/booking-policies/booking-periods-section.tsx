"use client"

import { useEffect, useState, useCallback } from "react"
import { normalizeCancellationRule } from "@/lib/cancellation-rules"
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
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import type { BookingPeriod, PolicyRule } from "./types"

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
  const [periodName, setPeriodName] = useState("")
  const [periodStart, setPeriodStart] = useState("")
  const [periodEnd, setPeriodEnd] = useState("")
  const [periodHoldEnabled, setPeriodHoldEnabled] = useState(true)
  const [periodHoldDays, setPeriodHoldDays] = useState(5)
  const [periodRules, setPeriodRules] = useState<PolicyRule[]>([
    { daysBeforeStay: 21, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0, creditFixedFeeCents: 0 },
    { daysBeforeStay: 14, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0, creditFixedFeeCents: 0 },
    { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0, creditFixedFeeCents: 0 },
  ])
  const [savingPeriod, setSavingPeriod] = useState(false)
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
    setPeriodName("")
    setPeriodStart("")
    setPeriodEnd("")
    setPeriodHoldEnabled(true)
    setPeriodHoldDays(5)
    setPeriodRules([
      { daysBeforeStay: 21, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0, creditFixedFeeCents: 0 },
      { daysBeforeStay: 14, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0, creditFixedFeeCents: 0 },
      { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0, creditFixedFeeCents: 0 },
    ])
  }

  function startEditPeriod(period: BookingPeriod) {
    setEditingPeriodId(period.id)
    setPeriodName(period.name)
    setPeriodStart(period.startDate.split("T")[0])
    setPeriodEnd(period.endDate.split("T")[0])
    setPeriodHoldEnabled(period.nonMemberHoldEnabled ?? true)
    setPeriodHoldDays(period.nonMemberHoldDays)
    setPeriodRules(period.cancellationRules.map((rule) => normalizeCancellationRule(rule)))
    setShowPeriodForm(true)
  }

  async function handleSavePeriod() {
    setSavingPeriod(true)
    setError("")
    setSuccess("")
    try {
      const url = editingPeriodId
        ? `/api/admin/booking-policies/periods/${editingPeriodId}`
        : "/api/admin/booking-policies/periods"
      const method = editingPeriodId ? "PUT" : "POST"

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: periodName,
          startDate: periodStart,
          endDate: periodEnd,
          nonMemberHoldEnabled: periodHoldEnabled,
          nonMemberHoldDays: periodHoldDays,
          cancellationRules: periodRules,
          // Partition is set at creation; edits keep the row's partition.
          ...(editingPeriodId ? {} : scopeLodgeId ? { lodgeId: scopeLodgeId } : {}),
        }),
      })
      if (!res.ok) {
        if (res.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON)
          return
        }
        const data = await res.json()
        throw new Error(data.error || "Failed to save period")
      }
      resetPeriodForm()
      fetchPeriods()
      setSuccess(editingPeriodId ? "Period updated" : "Period created")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSavingPeriod(false)
    }
  }

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
              <ViewOnlyActionButton canEdit={canEdit} onClick={() => setShowPeriodForm(true)}>Add Period</ViewOnlyActionButton>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canEdit && (
            <AdminViewOnlyNotice>
              Your admin role can view booking periods but cannot change them.
              Bookings edit access is required.
            </AdminViewOnlyNotice>
          )}
          {/* Period Form */}
          {showPeriodForm && (
            <Card className="border-blue-200 bg-blue-50/30">
              <CardContent className="pt-6 space-y-4">
                <h3 className="font-semibold">
                  {editingPeriodId ? "Edit Period" : "New Period"}
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="pName">Period Name</Label>
                    <Input
                      id="pName"
                      value={periodName}
                      onChange={(e) => setPeriodName(e.target.value)}
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
                      value={periodHoldDays}
                      onChange={(e) => setPeriodHoldDays(parseInt(e.target.value) || 5)}
                      className="w-24"
                      disabled={!periodHoldEnabled}
                    />
                    <p className="text-xs text-muted-foreground">
                      {periodHoldEnabled
                        ? "Used only when this period applies and Members First is enabled."
                        : "Stored but inactive while this period uses First Paid, First In."}
                    </p>
                  </div>
                  <label className="flex items-start gap-3 rounded-md border p-3 md:col-span-2">
                    <Checkbox
                      checked={periodHoldEnabled}
                      onCheckedChange={setPeriodHoldEnabled}
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
                      value={periodStart}
                      onChange={(e) => setPeriodStart(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pEnd">End Date</Label>
                    <Input
                      id="pEnd"
                      type="date"
                      value={periodEnd}
                      onChange={(e) => setPeriodEnd(e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-sm font-semibold">Cancellation Rules for this Period</Label>
                  <CancellationRulesEditor rules={periodRules} onChange={setPeriodRules} />
                </div>

                <div>
                  <Label className="text-sm font-semibold">Preview</Label>
                  <PolicyPreview rules={periodRules} />
                </div>

                <div className="flex space-x-3">
                  <Button onClick={handleSavePeriod} disabled={savingPeriod || !periodName || !periodStart || !periodEnd}>
                    {savingPeriod ? "Saving..." : editingPeriodId ? "Update Period" : "Create Period"}
                  </Button>
                  <Button variant="outline" onClick={resetPeriodForm}>Cancel</Button>
                </div>
              </CardContent>
            </Card>
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
                        <ViewOnlyActionButton canEdit={canEdit} variant="outline" size="sm" onClick={() => handleTogglePeriod(period)}>
                          {period.active ? "Deactivate" : "Activate"}
                        </ViewOnlyActionButton>
                        <ViewOnlyActionButton canEdit={canEdit} variant="outline" size="sm" onClick={() => startEditPeriod(period)}>
                          Edit
                        </ViewOnlyActionButton>
                        <ViewOnlyActionButton canEdit={canEdit} variant="destructive" size="sm" onClick={() => handleDeletePeriod(period.id)}>
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
