"use client"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useClubIdentity } from "@/components/club-identity-provider"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state"
import {
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { PolicyFeedback } from "./policy-feedback"

// Reference implementation of the canonical settings-section pattern
// (`AGENTS.md`): loads read-only, a per-section Edit reveals Save/Cancel, no
// control auto-persists, Cancel reverts to the saved snapshot, and Save
// persists once and re-seeds from the server response. The draft/snapshot
// bookkeeping lives in `useSectionEditState` (#2136).

interface GroupDiscountDraft {
  minGroupSize: number
  summerOnly: boolean
  enabled: boolean
}

const GROUP_DISCOUNT_DEFAULTS: GroupDiscountDraft = {
  minGroupSize: 5,
  summerOnly: true,
  enabled: false,
}

const ENDPOINT = "/api/admin/booking-policies/group-discount"

function toDraft(data: {
  minGroupSize: number
  summerOnly: boolean
  enabled: boolean
}): GroupDiscountDraft {
  return {
    minGroupSize: data.minGroupSize,
    summerOnly: data.summerOnly,
    enabled: data.enabled,
  }
}

export function GroupDiscountSection() {
  const { lodgeCapacity } = useClubIdentity()
  // Booking-policy config gates on the bookings area (its write route enforces
  // bookings:edit); a bookings:view admin sees it read-only (#1940).
  const canEdit = useAdminAreaEditAccess("bookings")

  const section = useSectionEditState<GroupDiscountDraft>({
    // Seeded so a failed load still renders the form with its defaults
    // alongside the error, as it always has.
    initial: GROUP_DISCOUNT_DEFAULTS,
    load: async () => {
      const res = await fetch(ENDPOINT)
      if (!res.ok) throw new Error("Failed to fetch group discount")
      return toDraft(await res.json())
    },
    save: async (draft) => {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      })
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError()
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      return toDraft(await res.json())
    },
    successMessage: "Group discount settings saved",
    // Save stays enabled while the draft is pristine, so an unchanged draft
    // still re-PUTs exactly as it did before the hook landed.
    allowPristineSave: true,
  })

  const { draft, editing, saving, error, success } = section

  if (section.loading || !draft) {
    return <div className="text-center py-8">Loading...</div>
  }

  return (
    <div className="space-y-6">
      <PolicyFeedback
        error={error}
        success={success}
        onClearError={() => section.setError("")}
        onClearSuccess={() => section.setSuccess("")}
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Group Discount</CardTitle>
            <CardDescription>
              When a booking has enough guests, all guests are charged at member rates.
            </CardDescription>
          </div>
          {!editing && (
            <ViewOnlyActionButton canEdit={canEdit} variant="outline" size="sm" onClick={section.startEditing}>
              Edit
            </ViewOnlyActionButton>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <AdminViewOnlyNotice canEdit={canEdit}>
            Your admin role can view the group discount policy but cannot change
            it. Bookings edit access is required.
          </AdminViewOnlyNotice>
          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="groupEnabled"
              checked={draft.enabled}
              onChange={(e) => section.setDraft({ enabled: e.target.checked })}
              className="rounded border-input"
              disabled={!editing}
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
                value={draft.minGroupSize}
                onChange={(e) =>
                  section.setDraft({ minGroupSize: parseInt(e.target.value) || 5 })
                }
                className={`w-20 ${!editing ? "bg-slate-50 text-slate-700" : ""}`}
                disabled={!editing}
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
              checked={draft.summerOnly}
              onChange={(e) => section.setDraft({ summerOnly: e.target.checked })}
              className="rounded border-input"
              disabled={!editing}
            />
            <Label htmlFor="groupSummerOnly">Summer seasons only</Label>
          </div>

          {editing && (
            <div className="flex space-x-3">
              <Button onClick={() => void section.save()} disabled={saving}>
                {saving ? "Saving..." : "Save Group Discount"}
              </Button>
              <Button variant="outline" onClick={section.cancelEditing} disabled={saving}>
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
