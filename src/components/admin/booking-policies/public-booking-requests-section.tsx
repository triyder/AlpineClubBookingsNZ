"use client"

import { useEffect, useState, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { PolicyFeedback } from "./policy-feedback"

export function PublicBookingRequestsSection() {
  const [showPricingToNonMembers, setShowPricingToNonMembers] = useState(false)
  const [loadingBookingRequestSettings, setLoadingBookingRequestSettings] = useState(true)
  const [savingBookingRequestSettings, setSavingBookingRequestSettings] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const fetchBookingRequestSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/booking-requests/settings")
      if (!res.ok) throw new Error("Failed to fetch booking request settings")
      const data = await res.json()
      setShowPricingToNonMembers(data.showPricingToNonMembers)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoadingBookingRequestSettings(false)
    }
  }, [])

  useEffect(() => {
    fetchBookingRequestSettings()
  }, [fetchBookingRequestSettings])

  async function handleToggleShowPricing(checked: boolean) {
    setSavingBookingRequestSettings(true)
    setError("")
    setSuccess("")
    try {
      const res = await fetch("/api/admin/booking-requests/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ showPricingToNonMembers: checked }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      const data = await res.json()
      setShowPricingToNonMembers(data.showPricingToNonMembers)
      setSuccess("Booking request settings saved")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSavingBookingRequestSettings(false)
    }
  }

  if (loadingBookingRequestSettings) {
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
        <CardHeader>
          <CardTitle>Public Booking Requests</CardTitle>
          <CardDescription>
            Control whether the public booking request form shows indicative pricing to non-members.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="showPricingToNonMembers"
              checked={showPricingToNonMembers}
              onChange={(e) => handleToggleShowPricing(e.target.checked)}
              className="rounded border-input"
              disabled={savingBookingRequestSettings}
            />
            <Label htmlFor="showPricingToNonMembers">Show indicative pricing on the request form</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            When enabled, the public form is labelled &ldquo;Request to Book&rdquo; and shows an indicative
            price. When disabled, it is labelled &ldquo;Request for Price&rdquo; and no pricing is shown
            until an officer reviews the request.
          </p>
          <p className="text-xs text-muted-foreground">
            Submitted requests that are declined, or never have their email verified, are automatically
            purged after 90 days in line with the Privacy Act 2020.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
