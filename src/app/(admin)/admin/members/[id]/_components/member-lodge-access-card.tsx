"use client"

import { useCallback, useEffect, useState } from "react"
import {
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
  type AncestorViewOnlyBannerProps,
} from "@/components/admin/view-only-action"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { useLodgeOptions } from "@/components/lodge-select"

interface LodgeAccessRow {
  id: string
  lodgeId: string
  kind: "BOOKING_RESTRICTION" | "STAFF"
}

// Per-lodge access grants for one member (multi-lodge phase 7 admin UI over
// the phase-4 API). Booking restriction is default-open: no ticked lodges
// means the member may book every lodge. STAFF grants bind a kiosk account
// to its lodge. Renders nothing while fewer than two lodges exist (ADR-002
// presentation rule).
interface MemberLodgeAccessCardProps extends AncestorViewOnlyBannerProps {
  memberId: string
}

export function MemberLodgeAccessCard({
  memberId,
  ancestorRendersViewOnlyBanner = false,
}: MemberLodgeAccessCardProps) {
  // lodge-access writes /api/admin/members/[id]/lodge-access (membership area);
  // a view-only membership admin sees the grants but cannot change them (#1997).
  const canEdit = useAdminAreaEditAccess("membership")
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [bookingRestrictionLodgeIds, setBookingRestrictionLodgeIds] = useState<
    string[]
  >([])
  const [staffLodgeIds, setStaffLodgeIds] = useState<string[]>([])

  const loadAccess = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`/api/admin/members/${memberId}/lodge-access`)
      const body = await res.json()
      if (!res.ok) {
        throw new Error(body.error || "Failed to load lodge access")
      }
      const rows = (body.lodgeAccess ?? []) as LodgeAccessRow[]
      setBookingRestrictionLodgeIds(
        rows
          .filter((row) => row.kind === "BOOKING_RESTRICTION")
          .map((row) => row.lodgeId),
      )
      setStaffLodgeIds(
        rows.filter((row) => row.kind === "STAFF").map((row) => row.lodgeId),
      )
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load lodge access",
      )
    } finally {
      setLoading(false)
    }
  }, [memberId])

  useEffect(() => {
    void loadAccess()
  }, [loadAccess])

  async function save() {
    setSaving(true)
    setError("")
    setSuccess("")
    try {
      const res = await fetch(`/api/admin/members/${memberId}/lodge-access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingRestrictionLodgeIds, staffLodgeIds }),
      })
      const body = await res.json()
      if (!res.ok) {
        throw new Error(body.error || "Failed to save lodge access")
      }
      setSuccess("Lodge access saved.")
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save lodge access",
      )
    } finally {
      setSaving(false)
    }
  }

  function toggle(
    lodgeId: string,
    checked: boolean,
    setIds: React.Dispatch<React.SetStateAction<string[]>>,
  ) {
    setSuccess("")
    setIds((current) =>
      checked ? [...current, lodgeId] : current.filter((id) => id !== lodgeId),
    )
  }

  // Single-lodge presentation rule: the card only exists once a second
  // active lodge does.
  if (lodgesLoading || lodges.length < 2) {
    return null
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Lodge Access</CardTitle>
        <CardDescription>
          Booking access is open by default: with no lodges ticked this member
          can book every lodge. Ticking lodges restricts their bookings to
          those lodges only. Staff grants bind a kiosk account to its lodge.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading lodge access...</p>
        ) : (
          <div className="space-y-4">
            {/*
              #2168: this Notice also covers the disabled CHECKBOXES below,
              which are not ViewOnlyActionButtons, so it is dropped only when an
              ancestor vouches that it states the same membership scope above
              this card — on `/admin/members/[id]` the page banner does. Rendered
              standalone, or under any parent that does not vouch, the Notice
              stays and this card still explains itself.
            */}
            {!ancestorRendersViewOnlyBanner ? (
              <AdminViewOnlyNotice canEdit={canEdit}>
                Your admin role can view lodge access but cannot change it.
              </AdminViewOnlyNotice>
            ) : null}
            <div className="space-y-2">
              <Label>Restrict bookings to</Label>
              <div className="flex flex-wrap gap-4">
                {lodges.map((lodge) => (
                  <label key={lodge.id} className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={bookingRestrictionLodgeIds.includes(lodge.id)}
                      disabled={!canEdit}
                      onChange={(e) =>
                        toggle(
                          lodge.id,
                          e.target.checked,
                          setBookingRestrictionLodgeIds,
                        )
                      }
                      className="rounded border-input"
                    />
                    <span className="text-sm">{lodge.name}</span>
                  </label>
                ))}
              </div>
              {bookingRestrictionLodgeIds.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No restriction — this member can book every lodge.
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label>Staff (kiosk) lodges</Label>
              <div className="flex flex-wrap gap-4">
                {lodges.map((lodge) => (
                  <label key={lodge.id} className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={staffLodgeIds.includes(lodge.id)}
                      disabled={!canEdit}
                      onChange={(e) =>
                        toggle(lodge.id, e.target.checked, setStaffLodgeIds)
                      }
                      className="rounded border-input"
                    />
                    <span className="text-sm">{lodge.name}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Only needed for lodge-operational (kiosk) accounts; it does not
                affect booking access.
              </p>
            </div>
            {error ? <p className="text-sm text-danger-11">{error}</p> : null}
            {success ? (
              <p className="text-sm text-success-11">{success}</p>
            ) : null}
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={!ancestorRendersViewOnlyBanner}
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Lodge Access"}
            </ViewOnlyActionButton>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
