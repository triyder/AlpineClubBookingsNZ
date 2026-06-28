"use client"

import { X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Filters, XeroContactGroup, XeroFeatureFlags } from "../_types"
import { filterLabelMap, filterValueLabels } from "../_utils"

interface MemberFilterToolbarProps {
  search: string
  filters: Filters
  activeFilterCount: number
  xeroFeatures: XeroFeatureFlags
  xeroContactGroupsList: XeroContactGroup[]
  onSearchChange: (value: string) => void
  onSetFilter: (key: keyof Filters, value: string) => void
  onClearFilters: () => void
}

export function MemberFilterToolbar({
  search,
  filters,
  activeFilterCount,
  xeroFeatures,
  xeroContactGroupsList,
  onSearchChange,
  onSetFilter,
  onClearFilters,
}: MemberFilterToolbarProps) {
  const getFilterDisplayValue = (key: string, value: string) =>
    key === "xeroContactGroup"
      ? xeroContactGroupsList.find((group) => group.id === value)?.name ?? value
      : filterValueLabels[key as keyof Filters]?.[value] ?? value

  return (
    <>
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px] max-w-sm">
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search by name or email..."
            className="bg-white"
          />
        </div>
        <Select
          value={filters.role || "all"}
          onValueChange={(value) => onSetFilter("role", value === "all" ? "" : value)}
        >
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            <SelectItem value="MEMBER">Member</SelectItem>
            <SelectItem value="ADMIN">Admin</SelectItem>
            <SelectItem value="LODGE">Lodge</SelectItem>
            <SelectItem value="ASSOCIATE">Associate Member</SelectItem>
            <SelectItem value="LIFE">Life Member</SelectItem>
            <SelectItem value="NON_MEMBER">Non-Member</SelectItem>
            <SelectItem value="SCHOOL">School</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.financeAccess || "all"}
          onValueChange={(value) => onSetFilter("financeAccess", value === "all" ? "" : value)}
        >
          <SelectTrigger className="w-[170px]">
            <SelectValue placeholder="Finance" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Finance Access</SelectItem>
            <SelectItem value="NONE">No Finance Access</SelectItem>
            <SelectItem value="VIEWER">Finance Viewer</SelectItem>
            <SelectItem value="MANAGER">Finance Manager</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.lifecycleStatus || "nonArchived"}
          onValueChange={(value) =>
            onSetFilter("lifecycleStatus", value === "nonArchived" ? "" : value)
          }
        >
          <SelectTrigger className="w-[155px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="nonArchived">All Non-Archived</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
            <SelectItem value="all">All Including Archived</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.ageTier || "all"}
          onValueChange={(value) => onSetFilter("ageTier", value === "all" ? "" : value)}
        >
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Age Tier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tiers</SelectItem>
            <SelectItem value="INFANT">Infant</SelectItem>
            <SelectItem value="CHILD">Child</SelectItem>
            <SelectItem value="YOUTH">Youth</SelectItem>
            <SelectItem value="ADULT">Adult</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.familyGroup || "all"}
          onValueChange={(value) => onSetFilter("familyGroup", value === "all" ? "" : value)}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Family Group" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Family Groups</SelectItem>
            <SelectItem value="any">Family Group: Yes</SelectItem>
            <SelectItem value="none">Family Group: No</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.inviteStatus || "all"}
          onValueChange={(value) => onSetFilter("inviteStatus", value === "all" ? "" : value)}
        >
          <SelectTrigger className="w-[165px]">
            <SelectValue placeholder="Invite Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Invite Status</SelectItem>
            <SelectItem value="invite">Invite</SelectItem>
            <SelectItem value="resend-invite">Resend Invite</SelectItem>
            <SelectItem value="reset-password">Reset Password</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.xeroLinked || "all"}
          onValueChange={(value) => onSetFilter("xeroLinked", value === "all" ? "" : value)}
        >
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Xero" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Xero</SelectItem>
            <SelectItem value="true">Linked</SelectItem>
            <SelectItem value="false">Not Linked</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.subscription || "all"}
          onValueChange={(value) => onSetFilter("subscription", value === "all" ? "" : value)}
        >
          <SelectTrigger className="w-[170px]">
            <SelectValue placeholder="Subscription" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Subs</SelectItem>
            <SelectItem value="PAID">Paid</SelectItem>
            <SelectItem value="UNPAID">Unpaid</SelectItem>
            <SelectItem value="OVERDUE">Overdue</SelectItem>
            <SelectItem value="NOT_INVOICED">Not Invoiced</SelectItem>
            <SelectItem value="NONE">No Record</SelectItem>
            <SelectItem value="NOT_REQUIRED">Not Required</SelectItem>
          </SelectContent>
        </Select>
        {xeroFeatures.liveMemberGroupLookups && xeroContactGroupsList.length > 0 && (
          <Select
            value={filters.xeroContactGroup || "all"}
            onValueChange={(value) =>
              onSetFilter("xeroContactGroup", value === "all" ? "" : value)
            }
          >
            <SelectTrigger className="w-[170px]">
              <SelectValue placeholder="Xero Group" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Xero Groups</SelectItem>
              {xeroContactGroupsList.map((group) => (
                <SelectItem key={group.id} value={group.id}>
                  {group.name} ({group.contactCount})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {activeFilterCount > 0 && (
          <Button variant="ghost" size="sm" onClick={onClearFilters}>
            <X className="h-4 w-4 mr-1" />
            Clear ({activeFilterCount})
          </Button>
        )}
      </div>

      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(filters)
            .filter(([, value]) => value)
            .map(([key, value]) => (
              <Badge
                key={key}
                variant="secondary"
                className="inline-flex items-center gap-1 cursor-pointer"
                onClick={() => onSetFilter(key as keyof Filters, "")}
              >
                {filterLabelMap[key as keyof Filters]}: {getFilterDisplayValue(key, value)}
                <X className="h-3 w-3" />
              </Badge>
            ))}
        </div>
      )}
    </>
  )
}
