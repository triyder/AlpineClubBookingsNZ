"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { HeartHandshake, Trash2 } from "lucide-react"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { useDebouncedMemberSearch } from "@/hooks/use-debounced-member-search"
import type {
  SerializedPartnerLinkState,
  SerializedPartnerLinkView,
} from "@/lib/partner-link-views"

interface PartnerSearchResult {
  id: string
  firstName: string
  lastName: string
  email: string
}

interface MemberPartnerLinkCardProps {
  memberId: string
  isAdultMember: boolean
  memberIsArchived: boolean
  currentMemberPath: string
  className?: string
}

/**
 * Admin view of a member's declared Partner/Husband/Wife relationship
 * (#1742): shows the confirmed link and pending requests, assigns a partner
 * directly (CONFIRMED immediately, no consent round-trip), and removes links.
 */
export function MemberPartnerLinkCard({
  memberId,
  isAdultMember,
  memberIsArchived,
  currentMemberPath,
  className,
}: MemberPartnerLinkCardProps) {
  const router = useRouter()
  const [state, setState] = useState<SerializedPartnerLinkState | null>(null)
  const [assignOpen, setAssignOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [saving, setSaving] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [error, setError] = useState("")

  // partnerLinkEligibleFor filters server-side (active adults, not this
  // member, no existing confirmed partner) so a page of results is never
  // emptied by client-side filtering.
  const {
    results: searchResults,
    searching,
    error: searchError,
  } = useDebouncedMemberSearch<PartnerSearchResult>({
    query: search,
    enabled: assignOpen,
    params: { pageSize: "8", partnerLinkEligibleFor: memberId },
  })

  async function loadState() {
    const res = await fetch(`/api/admin/members/${memberId}/partner-link`)
    if (!res.ok) return
    setState(await res.json())
  }

  useEffect(() => {
    loadState().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId])

  async function handleAssign(partnerMemberId: string) {
    setError("")
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/members/${memberId}/partner-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerMemberId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || "Failed to assign partner")
        return
      }
      toast.success(data.message || "Partner assigned")
      setAssignOpen(false)
      setSearch("")
      await loadState()
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove(linkId: string) {
    setError("")
    setRemovingId(linkId)
    try {
      const res = await fetch(
        `/api/admin/members/${memberId}/partner-link?id=${encodeURIComponent(linkId)}`,
        { method: "DELETE" }
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || "Failed to remove partner link")
        return
      }
      toast.success(data.message || "Partner link removed")
      await loadState()
    } finally {
      setRemovingId(null)
    }
  }

  const pending = [...(state?.pendingIncoming ?? []), ...(state?.pendingOutgoing ?? [])]

  function renderLinkRow(link: SerializedPartnerLinkView, confirmed: boolean) {
    return (
      <div
        key={link.id}
        className="flex flex-col gap-3 rounded-md border border-slate-200 p-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-slate-900">
              {link.partner.firstName} {link.partner.lastName}
            </p>
            {confirmed ? (
              <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200">
                Confirmed
              </Badge>
            ) : (
              <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-amber-200">
                Pending consent
              </Badge>
            )}
            {link.assignedByAdmin && <Badge variant="secondary">Admin assigned</Badge>}
            {!link.partner.canLogin && (
              <Badge variant="secondary" className="bg-purple-100 text-purple-800 border-purple-200">
                Non-Login
              </Badge>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              router.push(
                buildHrefWithReturnTo(`/admin/members/${link.partner.id}`, currentMemberPath)
              )
            }
          >
            View Partner
          </Button>
          {!memberIsArchived && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleRemove(link.id)}
              disabled={removingId === link.id}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              {removingId === link.id ? "Removing..." : "Remove"}
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base font-medium">Partner</CardTitle>
        {memberIsArchived ? (
          <Badge variant="secondary" className="bg-slate-200 text-slate-800 border-slate-300">
            Archived
          </Badge>
        ) : !state?.confirmed && isAdultMember ? (
          <Button variant="outline" size="sm" onClick={() => setAssignOpen((open) => !open)}>
            <HeartHandshake className="h-4 w-4 mr-1" />
            Assign Partner
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {(error || searchError) && (
            <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
              {error || searchError}
            </div>
          )}

          {state?.confirmed && renderLinkRow(state.confirmed, true)}
          {pending.map((link) => renderLinkRow(link, false))}

          {state && !state.confirmed && pending.length === 0 && (
            <p className="text-sm text-slate-500">
              {isAdultMember
                ? "No partner recorded."
                : "Partner relationships are for adult members only."}
            </p>
          )}

          {assignOpen && !memberIsArchived && (
            <div className="space-y-2 rounded-md border bg-slate-50 p-3">
              <Label htmlFor="partner-link-search">Partner search</Label>
              <Input
                id="partner-link-search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setError("")
                }}
                placeholder="Search by name or email"
              />
              {searching && <p className="text-xs text-slate-500">Searching…</p>}
              {search.trim().length >= 2 && searchResults.length > 0 ? (
                <div className="space-y-1">
                  {searchResults.map((candidate) => (
                    <div
                      key={candidate.id}
                      className="flex items-center justify-between rounded border bg-white p-2"
                    >
                      <div>
                        <p className="text-sm font-medium">
                          {candidate.firstName} {candidate.lastName}
                        </p>
                        <p className="text-xs text-slate-500">{candidate.email}</p>
                      </div>
                      <Button size="sm" disabled={saving} onClick={() => handleAssign(candidate.id)}>
                        {saving ? "Assigning..." : "Assign"}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : search.trim().length >= 2 && !searching ? (
                <p className="text-sm text-slate-500">No eligible adult members found.</p>
              ) : (
                <p className="text-sm text-slate-500">
                  Start typing at least 2 characters to search. Assigning records the
                  partnership immediately, without a consent round-trip.
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
