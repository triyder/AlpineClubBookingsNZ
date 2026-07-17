"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useClubIdentity } from "@/components/club-identity-provider"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { PolicyFeedback } from "./policy-feedback"

export function GroupDiscountSection() {
  const { lodgeCapacity } = useClubIdentity()
  // Booking-policy config gates on the bookings area (its write route enforces
  // bookings:edit); a bookings:view admin sees it read-only (#1940).
  const canEdit = useAdminAreaEditAccess("bookings")
  const [groupMinSize, setGroupMinSize] = useState(5)
  const [groupSummerOnly, setGroupSummerOnly] = useState(true)
  const [groupEnabled, setGroupEnabled] = useState(false)
  const [loadingGroup, setLoadingGroup] = useState(true)
  const [savingGroup, setSavingGroup] = useState(false)
  const [editingGroup, setEditingGroup] = useState(false)
  const [savedGroup, setSavedGroup] = useState({ minGroupSize: 5, summerOnly: true, enabled: false })
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const fetchGroupDiscount = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/booking-policies/group-discount")
      if (!res.ok) throw new Error("Failed to fetch group discount")
      const data = await res.json()
      setGroupMinSize(data.minGroupSize)
      setGroupSummerOnly(data.summerOnly)
      setGroupEnabled(data.enabled)
      setSavedGroup({ minGroupSize: data.minGroupSize, summerOnly: data.summerOnly, enabled: data.enabled })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoadingGroup(false)
    }
  }, [])

  useEffect(() => {
    fetchGroupDiscount()
  }, [fetchGroupDiscount])

  function handleCancelGroup() {
    setGroupMinSize(savedGroup.minGroupSize)
    setGroupSummerOnly(savedGroup.summerOnly)
    setGroupEnabled(savedGroup.enabled)
    setEditingGroup(false)
  }

  async function handleSaveGroup() {
    setSavingGroup(true)
    setError("")
    setSuccess("")
    try {
      const res = await fetch("/api/admin/booking-policies/group-discount", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          minGroupSize: groupMinSize,
          summerOnly: groupSummerOnly,
          enabled: groupEnabled,
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
      const data = await res.json()
      setGroupMinSize(data.minGroupSize)
      setGroupSummerOnly(data.summerOnly)
      setGroupEnabled(data.enabled)
      setSavedGroup({ minGroupSize: data.minGroupSize, summerOnly: data.summerOnly, enabled: data.enabled })
      setEditingGroup(false)
      setSuccess("Group discount settings saved")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSavingGroup(false)
    }
  }

  if (loadingGroup) {
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
            <CardTitle>Group Discount</CardTitle>
            <CardDescription>
              When a booking has enough guests, all guests are charged at member rates.
            </CardDescription>
          </div>
          {!editingGroup && (
            <ViewOnlyActionButton canEdit={canEdit} variant="outline" size="sm" onClick={() => setEditingGroup(true)}>
              Edit
            </ViewOnlyActionButton>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {!canEdit && (
            <AdminViewOnlyNotice>
              Your admin role can view the group discount policy but cannot change
              it. Bookings edit access is required.
            </AdminViewOnlyNotice>
          )}
          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="groupEnabled"
              checked={groupEnabled}
              onChange={(e) => setGroupEnabled(e.target.checked)}
              className="rounded border-input"
              disabled={!editingGroup}
            />
            <Label htmlFor="groupEnabled">Enabled</Label>
          </div>

          <div className="space-y-2 max-w-xs">
            <Label htmlFor="groupMinSize">Minimum group size</Label>
            <div className="flex items-center space-x-2">
              <Input
                id="groupMinSize"
                type="number"
                min="2"
                max={String(lodgeCapacity)}
                value={groupMinSize}
                onChange={(e) => setGroupMinSize(parseInt(e.target.value) || 5)}
                className={`w-20 ${!editingGroup ? "bg-slate-50 text-slate-700" : ""}`}
                disabled={!editingGroup}
              />
              <span className="text-sm text-muted-foreground">guests</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Bookings with this many or more guests will have all guests charged at member rates.
            </p>
          </div>

          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="groupSummerOnly"
              checked={groupSummerOnly}
              onChange={(e) => setGroupSummerOnly(e.target.checked)}
              className="rounded border-input"
              disabled={!editingGroup}
            />
            <Label htmlFor="groupSummerOnly">Summer seasons only</Label>
          </div>

          {editingGroup && (
            <div className="flex space-x-3">
              <Button onClick={handleSaveGroup} disabled={savingGroup}>
                {savingGroup ? "Saving..." : "Save Group Discount"}
              </Button>
              <Button variant="outline" onClick={handleCancelGroup} disabled={savingGroup}>
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
