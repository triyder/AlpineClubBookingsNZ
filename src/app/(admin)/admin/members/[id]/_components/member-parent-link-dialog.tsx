"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Search } from "lucide-react"
import {
  dedupeParentOptions,
  formatMemberDateNz,
  parentLinkTypeLabel,
} from "@/lib/admin-member-detail-helpers"
import type { LinkParentSearchResult, MemberDetail } from "../_types"

interface MemberParentLinkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  member: MemberDetail
  search: string
  searching: boolean
  searchResults: LinkParentSearchResult[]
  selected: LinkParentSearchResult | null
  notificationParentId: string
  disableLogin: boolean
  familyGroupIds: string[]
  saving: boolean
  error: string
  onChangeSearch: (value: string) => void
  onSelectCandidate: (candidate: LinkParentSearchResult) => void
  onClearSelection: () => void
  onChangeNotificationParentId: (value: string) => void
  onChangeDisableLogin: (value: boolean) => void
  onToggleFamilyGroup: (familyGroupId: string, checked: boolean) => void
  onSubmit: () => void
}

export function MemberParentLinkDialog({
  open,
  onOpenChange,
  member,
  search,
  searching,
  searchResults,
  selected,
  notificationParentId,
  disableLogin,
  familyGroupIds,
  saving,
  error,
  onChangeSearch,
  onSelectCandidate,
  onClearSelection,
  onChangeNotificationParentId,
  onChangeDisableLogin,
  onToggleFamilyGroup,
  onSubmit,
}: MemberParentLinkDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Link Parent</DialogTitle>
          <DialogDescription>
            Link {member.firstName} {member.lastName} under an active adult member.
          </DialogDescription>
        </DialogHeader>
        {error && <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{error}</div>}
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="link-parent-search">Parent search</Label>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="link-parent-search"
                value={search}
                onChange={(e) => onChangeSearch(e.target.value)}
                placeholder="Search by name, email, or member ID"
                className="pl-9"
              />
              {searching && (
                <div className="absolute right-3 top-2.5 text-xs text-muted-foreground">Searching...</div>
              )}
            </div>
          </div>

          {selected ? (
            <div className="rounded-md border border-border p-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-foreground">
                      {selected.firstName} {selected.lastName}
                    </p>
                    <Badge variant="secondary">{selected.ageTier}</Badge>
                    {!selected.active && (
                      <Badge variant="secondary" className="bg-muted text-muted-foreground border-border">
                        Inactive
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{selected.email}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selected.canLogin ? "Can login" : "Non-login"}
                    {selected.dateOfBirth ? ` · DOB ${formatMemberDateNz(selected.dateOfBirth)}` : ""}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={onClearSelection} disabled={saving}>
                  Change
                </Button>
              </div>
            </div>
          ) : search.trim().length >= 2 && searchResults.length > 0 ? (
            <div className="max-h-56 overflow-y-auto rounded-md border border-border">
              {searchResults.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => onSelectCandidate(candidate)}
                  className="w-full border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
                >
                  <span className="font-medium">
                    {candidate.firstName} {candidate.lastName}
                  </span>
                  <span className="ml-2 text-muted-foreground">{candidate.email}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{candidate.ageTier}</span>
                </button>
              ))}
            </div>
          ) : search.trim().length >= 2 && !searching ? (
            <p className="text-sm text-muted-foreground">No eligible active adult members found.</p>
          ) : (
            <p className="text-sm text-muted-foreground">Start typing at least 2 characters to search.</p>
          )}

          {selected && (
            <div className="space-y-4">
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="space-y-2">
                  <Label htmlFor="link-parent-notification-source">Notification email recipient</Label>
                  <select
                    id="link-parent-notification-source"
                    value={notificationParentId}
                    onChange={(event) => onChangeNotificationParentId(event.target.value)}
                    disabled={saving}
                    className="flex h-10 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
                  >
                    <option value="">Use {member.firstName}&apos;s own email</option>
                    {dedupeParentOptions([
                      ...(member.parentLinks ?? []),
                      {
                        ...selected,
                        parentLinkType: ((member.parentLinks?.length ?? 0) === 0
                          ? "PRIMARY"
                          : "SECONDARY") as "PRIMARY" | "SECONDARY",
                      },
                    ]).map((parent) => (
                      <option key={parent.id} value={parent.id}>
                        {parent.firstName} {parent.lastName} ({parentLinkTypeLabel(parent.parentLinkType)})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="link-parent-disable-login"
                    checked={disableLogin}
                    onCheckedChange={(checked) => onChangeDisableLogin(checked === true)}
                    disabled={saving}
                  />
                  <Label htmlFor="link-parent-disable-login" className="text-sm font-normal">
                    Disable login
                  </Label>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Add to parent family groups</Label>
                {selected.familyGroups.length > 0 ? (
                  <div className="space-y-2 rounded-md border border-border p-3">
                    {selected.familyGroups.map((group) => (
                      <div key={group.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`link-parent-family-group-${group.id}`}
                          checked={familyGroupIds.includes(group.id)}
                          onCheckedChange={(checked) => onToggleFamilyGroup(group.id, checked === true)}
                          disabled={saving}
                        />
                        <Label
                          htmlFor={`link-parent-family-group-${group.id}`}
                          className="text-sm font-normal"
                        >
                          {group.name || "Unnamed group"}
                        </Label>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">This parent is not in any family groups.</p>
                )}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={saving || !selected}>
            {saving ? "Linking..." : "Link Parent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
