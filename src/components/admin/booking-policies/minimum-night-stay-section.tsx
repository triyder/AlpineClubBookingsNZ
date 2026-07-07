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
import { DAY_LABELS, type MinStayPolicy } from "./types"

export function MinimumNightStaySection() {
  // Per-lodge override scope (ADR-001 resolved question 3): null lists the
  // club-wide policies; a lodge lists its override set, which replaces the
  // club-wide set entirely at runtime. Hidden with fewer than two lodges.
  const [scopeLodgeId, setScopeLodgeId] = useState<string | null>(null)
  const scopeLodgeName = usePolicyScopeLodgeName(scopeLodgeId)
  const [minStayPolicies, setMinStayPolicies] = useState<MinStayPolicy[]>([])
  const [loadingMinStay, setLoadingMinStay] = useState(true)
  const [showMinStayForm, setShowMinStayForm] = useState(false)
  const [editingMinStayId, setEditingMinStayId] = useState<string | null>(null)
  const [msName, setMsName] = useState("")
  const [msStart, setMsStart] = useState("")
  const [msEnd, setMsEnd] = useState("")
  const [msTriggerDays, setMsTriggerDays] = useState<number[]>([6]) // default Saturday
  const [msMinNights, setMsMinNights] = useState(2)
  const [savingMinStay, setSavingMinStay] = useState(false)
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
    setMsName("")
    setMsStart("")
    setMsEnd("")
    setMsTriggerDays([6])
    setMsMinNights(2)
  }

  function startEditMinStay(policy: MinStayPolicy) {
    setEditingMinStayId(policy.id)
    setMsName(policy.name)
    setMsStart(policy.startDate.split("T")[0])
    setMsEnd(policy.endDate.split("T")[0])
    setMsTriggerDays(policy.triggerDays)
    setMsMinNights(policy.minimumNights)
    setShowMinStayForm(true)
  }

  function toggleTriggerDay(day: number) {
    setMsTriggerDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()
    )
  }

  async function handleSaveMinStay() {
    setSavingMinStay(true)
    setError("")
    setSuccess("")
    try {
      const url = editingMinStayId
        ? `/api/admin/booking-policies/minimum-stay/${editingMinStayId}`
        : "/api/admin/booking-policies/minimum-stay"
      const method = editingMinStayId ? "PUT" : "POST"

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: msName,
          startDate: msStart,
          endDate: msEnd,
          triggerDays: msTriggerDays,
          minimumNights: msMinNights,
          // Partition is set at creation; edits keep the row's partition.
          ...(editingMinStayId ? {} : scopeLodgeId ? { lodgeId: scopeLodgeId } : {}),
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      resetMinStayForm()
      fetchMinStay()
      setSuccess(editingMinStayId ? "Minimum stay policy updated" : "Minimum stay policy created")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSavingMinStay(false)
    }
  }

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
              <Button onClick={() => setShowMinStayForm(true)}>Add Policy</Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Min Stay Form */}
          {showMinStayForm && (
            <Card className="border-blue-200 bg-blue-50/30">
              <CardContent className="pt-6 space-y-4">
                <h3 className="font-semibold">
                  {editingMinStayId ? "Edit Policy" : "New Minimum Stay Policy"}
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="msName">Policy Name</Label>
                    <Input
                      id="msName"
                      value={msName}
                      onChange={(e) => setMsName(e.target.value)}
                      placeholder="e.g. Winter Saturday Minimum Stay"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="msMinNights">Minimum Nights</Label>
                    <Input
                      id="msMinNights"
                      type="number"
                      min="2"
                      value={msMinNights}
                      onChange={(e) => setMsMinNights(parseInt(e.target.value) || 2)}
                      className="w-24"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="msStart">Start Date</Label>
                    <Input
                      id="msStart"
                      type="date"
                      value={msStart}
                      onChange={(e) => setMsStart(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="msEnd">End Date</Label>
                    <Input
                      id="msEnd"
                      type="date"
                      value={msEnd}
                      onChange={(e) => setMsEnd(e.target.value)}
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
                          checked={msTriggerDays.includes(i)}
                          onCheckedChange={() => toggleTriggerDay(i)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex space-x-3">
                  <Button
                    onClick={handleSaveMinStay}
                    disabled={savingMinStay || !msName || !msStart || !msEnd || msTriggerDays.length === 0}
                  >
                    {savingMinStay ? "Saving..." : editingMinStayId ? "Update Policy" : "Create Policy"}
                  </Button>
                  <Button variant="outline" onClick={resetMinStayForm}>Cancel</Button>
                </div>
              </CardContent>
            </Card>
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
                        <Button variant="outline" size="sm" onClick={() => handleToggleMinStay(policy)}>
                          {policy.active ? "Deactivate" : "Activate"}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => startEditMinStay(policy)}>
                          Edit
                        </Button>
                        {policy.active && (
                          <Button variant="destructive" size="sm" onClick={() => handleDeleteMinStay(policy.id)}>
                            Deactivate
                          </Button>
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
