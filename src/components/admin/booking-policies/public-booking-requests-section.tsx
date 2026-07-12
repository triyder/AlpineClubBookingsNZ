"use client"

import { useEffect, useState, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { PolicyFeedback } from "./policy-feedback"

interface BookingRequestSettings {
  showPricingToNonMembers: boolean
  quoteResponseTtlDays: number
  quoteReminderLeadDays: number
  attendeeConfirmationLeadDays: number
  attendeeConfirmationReminderDays: number
}

export function PublicBookingRequestsSection() {
  const [settings, setSettings] = useState<BookingRequestSettings>({
    showPricingToNonMembers: false,
    quoteResponseTtlDays: 14,
    quoteReminderLeadDays: 3,
    attendeeConfirmationLeadDays: 14,
    attendeeConfirmationReminderDays: 3,
  })
  const [ttlDraft, setTtlDraft] = useState("14")
  const [reminderDraft, setReminderDraft] = useState("3")
  const [attendeeLeadDraft, setAttendeeLeadDraft] = useState("14")
  const [attendeeReminderDraft, setAttendeeReminderDraft] = useState("3")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const applySettings = useCallback((data: BookingRequestSettings) => {
    setSettings(data)
    setTtlDraft(String(data.quoteResponseTtlDays))
    setReminderDraft(String(data.quoteReminderLeadDays))
    setAttendeeLeadDraft(String(data.attendeeConfirmationLeadDays))
    setAttendeeReminderDraft(String(data.attendeeConfirmationReminderDays))
  }, [])

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/booking-requests/settings")
      if (!res.ok) throw new Error("Failed to fetch booking request settings")
      applySettings(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }, [applySettings])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  async function saveSettings(next: BookingRequestSettings) {
    setSaving(true)
    setError("")
    setSuccess("")
    try {
      const res = await fetch("/api/admin/booking-requests/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || "Failed to save")
      }
      applySettings(data)
      setSuccess("Booking request settings saved")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  function handleToggleShowPricing(checked: boolean) {
    void saveSettings({ ...settings, showPricingToNonMembers: checked })
  }

  function handleSaveQuoteTiming() {
    const ttl = Number(ttlDraft)
    const reminder = Number(reminderDraft)
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 60) {
      setError("Quote response window must be a whole number of days between 1 and 60.")
      return
    }
    if (!Number.isInteger(reminder) || reminder < 0 || reminder > 30) {
      setError("Reminder lead time must be a whole number of days between 0 and 30.")
      return
    }
    if (reminder >= ttl) {
      setError("Reminder lead time must be shorter than the quote response window.")
      return
    }
    void saveSettings({
      ...settings,
      quoteResponseTtlDays: ttl,
      quoteReminderLeadDays: reminder,
    })
  }

  function handleSaveAttendeeTiming() {
    const lead = Number(attendeeLeadDraft)
    const reminder = Number(attendeeReminderDraft)
    if (!Number.isInteger(lead) || lead < 0 || lead > 90) {
      setError("The attendee prompt lead time must be a whole number of days between 0 and 90.")
      return
    }
    if (!Number.isInteger(reminder) || reminder < 1 || reminder > 30) {
      setError("The attendee reminder interval must be a whole number of days between 1 and 30.")
      return
    }
    void saveSettings({
      ...settings,
      attendeeConfirmationLeadDays: lead,
      attendeeConfirmationReminderDays: reminder,
    })
  }

  if (loading) {
    return <div className="text-center py-8">Loading...</div>
  }

  const timingDirty =
    Number(ttlDraft) !== settings.quoteResponseTtlDays ||
    Number(reminderDraft) !== settings.quoteReminderLeadDays
  const attendeeTimingDirty =
    Number(attendeeLeadDraft) !== settings.attendeeConfirmationLeadDays ||
    Number(attendeeReminderDraft) !== settings.attendeeConfirmationReminderDays

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
          <CardTitle>Indicative Pricing</CardTitle>
          <CardDescription>
            Control whether the public booking request form shows indicative pricing to non-members.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="showPricingToNonMembers"
              checked={settings.showPricingToNonMembers}
              onChange={(e) => handleToggleShowPricing(e.target.checked)}
              className="rounded border-input"
              disabled={saving}
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

      <Card>
        <CardHeader>
          <CardTitle>Quote Response Window &amp; Reminders</CardTitle>
          <CardDescription>
            Set how long a quote link stays valid after you send it, and when the requester is reminded
            before it expires.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1">
            <Label htmlFor="quoteResponseTtlDays">Quote response window (days)</Label>
            <input
              type="number"
              id="quoteResponseTtlDays"
              min={1}
              max={60}
              value={ttlDraft}
              onChange={(e) => setTtlDraft(e.target.value)}
              className="block w-28 rounded border border-input px-2 py-1 text-sm"
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              How many days the requester has to accept, cancel, or reply before the secure quote link
              expires. Applies to quotes sent from now on; quotes already sent keep their original expiry.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="quoteReminderLeadDays">Reminder lead time (days before expiry)</Label>
            <input
              type="number"
              id="quoteReminderLeadDays"
              min={0}
              max={30}
              value={reminderDraft}
              onChange={(e) => setReminderDraft(e.target.value)}
              className="block w-28 rounded border border-input px-2 py-1 text-sm"
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              Send the requester one reminder this many days before the quote expires. The reminder
              contains a fresh, working quote link so they never have to find the original email. Set to
              0 to turn reminders off. Must be shorter than the response window above.
            </p>
          </div>

          <button
            type="button"
            onClick={handleSaveQuoteTiming}
            disabled={saving || !timingDirty}
            className="rounded bg-brand-charcoal px-3 py-1.5 text-sm font-medium text-brand-snow disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save quote timing"}
          </button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>School Attendee Confirmation</CardTitle>
          <CardDescription>
            Before a school group arrives, the school contact is emailed a secure link to replace the
            placeholder attendee names and confirm who is coming. The chore roster uses the confirmed
            names.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="attendeeConfirmationLeadDays">First prompt (days before check-in)</Label>
            <input
              type="number"
              id="attendeeConfirmationLeadDays"
              min={0}
              max={90}
              value={attendeeLeadDraft}
              onChange={(e) => setAttendeeLeadDraft(e.target.value)}
              className="block w-28 rounded border border-input px-2 py-1 text-sm"
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              Start prompting the school this many days before check-in. Set to 0 to turn the prompts
              off.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="attendeeConfirmationReminderDays">Reminder interval (days)</Label>
            <input
              type="number"
              id="attendeeConfirmationReminderDays"
              min={1}
              max={30}
              value={attendeeReminderDraft}
              onChange={(e) => setAttendeeReminderDraft(e.target.value)}
              className="block w-28 rounded border border-input px-2 py-1 text-sm"
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              Keep re-sending the confirmation link this often until the school confirms the list or
              check-in arrives. Each email carries a fresh working link.
            </p>
          </div>

          <button
            type="button"
            onClick={handleSaveAttendeeTiming}
            disabled={saving || !attendeeTimingDirty}
            className="rounded bg-brand-charcoal px-3 py-1.5 text-sm font-medium text-brand-snow disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save attendee prompts"}
          </button>
        </CardContent>
      </Card>
    </div>
  )
}
