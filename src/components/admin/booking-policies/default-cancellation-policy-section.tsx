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
import type { PolicyRule } from "./types"

export function DefaultCancellationPolicySection() {
  const [defaultRules, setDefaultRules] = useState<PolicyRule[]>([])
  const [defaultHoldEnabled, setDefaultHoldEnabled] = useState(true)
  const [defaultHoldDays, setDefaultHoldDays] = useState(7)
  const [loadingDefaults, setLoadingDefaults] = useState(true)
  const [savingDefaults, setSavingDefaults] = useState(false)
  const [editingDefaults, setEditingDefaults] = useState(false)
  const [savedDefaultRules, setSavedDefaultRules] = useState<PolicyRule[]>([])
  const [savedDefaultHoldEnabled, setSavedDefaultHoldEnabled] = useState(true)
  const [savedDefaultHoldDays, setSavedDefaultHoldDays] = useState(7)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const fetchDefaults = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/booking-policies/cancellation")
      if (!res.ok) throw new Error("Failed to fetch policy")
      const data = await res.json()
      const rules = data.rules && data.rules.length > 0
        ? data.rules.map((r: PolicyRule) => normalizeCancellationRule(r))
        : [
            { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0, creditFixedFeeCents: 0 },
            { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0, creditFixedFeeCents: 0 },
            { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0, creditFixedFeeCents: 0 },
          ]
      const holdEnabled = data.nonMemberHoldEnabled ?? true
      const holdDays = data.nonMemberHoldDays ?? 7
      setDefaultRules(rules)
      setDefaultHoldEnabled(holdEnabled)
      setDefaultHoldDays(holdDays)
      setSavedDefaultRules(rules)
      setSavedDefaultHoldEnabled(holdEnabled)
      setSavedDefaultHoldDays(holdDays)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoadingDefaults(false)
    }
  }, [])

  useEffect(() => {
    fetchDefaults()
  }, [fetchDefaults])

  function handleCancelDefaults() {
    setDefaultRules(savedDefaultRules)
    setDefaultHoldEnabled(savedDefaultHoldEnabled)
    setDefaultHoldDays(savedDefaultHoldDays)
    setEditingDefaults(false)
  }

  async function handleSaveDefaults() {
    setSavingDefaults(true)
    setError("")
    setSuccess("")
    try {
      const res = await fetch("/api/admin/booking-policies/cancellation", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules: defaultRules,
          nonMemberHoldEnabled: defaultHoldEnabled,
          nonMemberHoldDays: defaultHoldDays,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      const data = await res.json()
      const rules = data.rules.map((rule: PolicyRule) => normalizeCancellationRule(rule))
      setDefaultRules(rules)
      setDefaultHoldEnabled(data.nonMemberHoldEnabled ?? true)
      setDefaultHoldDays(data.nonMemberHoldDays)
      setSavedDefaultRules(rules)
      setSavedDefaultHoldEnabled(data.nonMemberHoldEnabled ?? true)
      setSavedDefaultHoldDays(data.nonMemberHoldDays)
      setEditingDefaults(false)
      setSuccess("Default policy saved")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSavingDefaults(false)
    }
  }

  if (loadingDefaults) {
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

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Default Policy</CardTitle>
            <CardDescription>
              These rules apply to all bookings unless a date-specific period overrides them.
            </CardDescription>
          </div>
          {!editingDefaults && (
            <Button variant="outline" size="sm" onClick={() => setEditingDefaults(true)}>
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4 max-w-xl">
            <div className="flex items-start gap-3 rounded-md border p-3">
              <Checkbox
                id="nonMemberHoldEnabled"
                checked={defaultHoldEnabled}
                disabled={!editingDefaults}
                onCheckedChange={setDefaultHoldEnabled}
              />
              <div className="space-y-1">
                <Label htmlFor="nonMemberHoldEnabled">Members First booking policy</Label>
                <p className="text-xs text-muted-foreground">
                  When enabled, non-member guests outside the threshold are held provisionally.
                  When disabled, mixed member and non-member bookings proceed as First Paid, First In.
                </p>
              </div>
            </div>
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
            <div className="flex space-x-3">
              <Button onClick={handleSaveDefaults} disabled={savingDefaults}>
                {savingDefaults ? "Saving..." : "Save Default Policy"}
              </Button>
              <Button variant="outline" onClick={handleCancelDefaults} disabled={savingDefaults}>
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
