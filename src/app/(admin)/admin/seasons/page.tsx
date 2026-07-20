"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert } from "@/components/ui/alert"
import { AdminPageHeader } from "@/components/admin/admin-page-header"
import { AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  LodgeSelect,
  initialLodgeIdFromLocation,
  useLodgeOptions,
} from "@/components/lodge-select"

// Season WINDOWS only (#1933, E7): name, type, dates, and active state per
// lodge. Nightly rates moved to the consolidated Fees console (Fees → Hut Fees)
// — editing a window here PUTs without `membershipTypeRates`, so the season's
// rates are left untouched. Creating a season (which requires at least one rate)
// also lives in Fees → Hut Fees, so this page edits existing windows only.

interface Season {
  id: string
  name: string
  type: "WINTER" | "SUMMER"
  startDate: string
  endDate: string
  active: boolean
}

export default function SeasonsPage() {
  const [seasons, setSeasons] = useState<Season[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const canEdit = useAdminAreaEditAccess("bookings")
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin")
  const [lodgeId, setLodgeId] = useState<string | null>(initialLodgeIdFromLocation)

  // Form state (window fields only)
  const [name, setName] = useState("")
  const [type, setType] = useState<"WINTER" | "SUMMER">("WINTER")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [active, setActive] = useState(true)
  const [saving, setSaving] = useState(false)

  const fetchSeasons = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(
        lodgeId
          ? `/api/admin/seasons?lodgeId=${encodeURIComponent(lodgeId)}`
          : "/api/admin/seasons",
        { signal },
      )
      if (!res.ok) throw new Error("Failed to fetch seasons")
      const data = await res.json()
      setSeasons(data)
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }, [lodgeId])

  useEffect(() => {
    const controller = new AbortController()
    fetchSeasons(controller.signal)
    return () => controller.abort()
  }, [fetchSeasons])

  function resetForm() {
    setName("")
    setType("WINTER")
    setStartDate("")
    setEndDate("")
    setActive(true)
    setEditingId(null)
    setError("")
  }

  function startEdit(season: Season) {
    setEditingId(season.id)
    setName(season.name)
    setType(season.type)
    setStartDate(season.startDate.split("T")[0])
    setEndDate(season.endDate.split("T")[0])
    setActive(season.active)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!editingId) return
    setSaving(true)
    setError("")

    // Window-only PUT: omit membershipTypeRates so the [id] route leaves the
    // season's existing rates untouched (see the route's `if (membershipTypeRates)`
    // guard). Rates are edited in Fees → Hut Fees.
    const payload = { name, type, startDate, endDate, active }

    try {
      const res = await fetch(`/api/admin/seasons/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to save season")
      }
      resetForm()
      fetchSeasons()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this season?")) return
    try {
      const res = await fetch(`/api/admin/seasons/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to delete")
      }
      fetchSeasons()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  async function handleToggleActive(season: Season) {
    try {
      const res = await fetch(`/api/admin/seasons/${season.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !season.active }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to update")
      }
      fetchSeasons()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the page —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted (the component renders it whatever `canEdit` is) so the live region
    is registered in the accessibility tree before its content appears; a region
    injected already-populated is silently dropped by some screen-reader/browser
    pairings. It sits OUTSIDE the `space-y-6` stack so the empty wrapper an
    edit-capable admin gets costs no layout — the spacing lives on the inner box.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Bookings view access can inspect season windows. Bookings edit access is required to change them.
    </AdminViewOnlySectionBanner>
  )

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <AdminPageHeader
        title="Seasons"
        description="Season windows (name, type, dates, and active state) per lodge. Set nightly rates and add new seasons in Fees → Hut Fees."
      />

      <Alert>
        <span>
          To add a season or change its nightly rates, use{" "}
          <Link href="/admin/fees" className="underline font-medium">Fees → Hut Fees</Link>.
          This page edits an existing season&apos;s window (dates, name, type, active) and leaves its rates untouched.
        </span>
      </Alert>

      <div className="max-w-xs">
        <LodgeSelect lodges={lodges} value={lodgeId} onChange={setLodgeId} loading={lodgesLoading} />
      </div>

      {error && (
        <div role="alert" className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
          {error}
        </div>
      )}

      {editingId && canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>Edit Season Window</CardTitle>
            <CardDescription>Update the season period, name, type, and active state. Rates are unchanged.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Season Name</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Winter 2026" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="type">Type</Label>
                  <select
                    id="type"
                    value={type}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setType(e.target.value as "WINTER" | "SUMMER")}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                  >
                    <option value="WINTER">Winter</option>
                    <option value="SUMMER">Summer</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="startDate">Start Date</Label>
                  <Input id="startDate" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="endDate">End Date</Label>
                  <Input id="endDate" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <input type="checkbox" id="active" checked={active} onChange={(e) => setActive(e.target.checked)} className="rounded border-input" />
                <Label htmlFor="active">Active</Label>
              </div>

              <div className="flex space-x-3">
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Update Season"}
                </Button>
                <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="text-center py-8">Loading seasons...</div>
      ) : seasons.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No seasons configured yet. Add one in Fees → Hut Fees.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {seasons.map((season) => (
            <Card key={season.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <CardTitle className="text-xl">{season.name}</CardTitle>
                    <Badge variant={season.type === "WINTER" ? "default" : "secondary"}>{season.type}</Badge>
                    <Badge variant={season.active ? "default" : "outline"}>{season.active ? "Active" : "Inactive"}</Badge>
                  </div>
                  {canEdit && (
                    <div className="flex space-x-2">
                      <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => handleToggleActive(season)}>
                        {season.active ? "Deactivate" : "Activate"}
                      </ViewOnlyActionButton>
                      <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => startEdit(season)}>
                        Edit window
                      </ViewOnlyActionButton>
                      <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="destructive" size="sm" onClick={() => handleDelete(season.id)}>
                        Delete
                      </ViewOnlyActionButton>
                    </div>
                  )}
                </div>
                <CardDescription>
                  {new Date(season.startDate).toLocaleDateString("en-NZ")} &mdash;{" "}
                  {new Date(season.endDate).toLocaleDateString("en-NZ")}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
      </div>
    </div>
  )
}
