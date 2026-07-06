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
import { useAccessRoleOptions } from "@/hooks/use-access-role-options"
import { useMembershipTypeOptions } from "@/hooks/use-membership-type-options"
import { UNASSIGNED_MEMBERSHIP_TYPE_VALUE } from "@/lib/membership-type-filter"
import { NON_MEMBER_ROLE_VALUES, ROLE_LABELS } from "@/lib/member-roles"
import {
  LOGIN_STAGE_FILTER_VALUES,
  LOGIN_STAGE_LABELS,
  type MemberLoginStage,
} from "@/lib/member-login-stage"
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
  const roleOptions = useAccessRoleOptions()
  const membershipTypeOptions = useMembershipTypeOptions()
  // The `role` filter param is shared by the Access Role and Non-Member
  // Category selects (backend reads a single `role` param); the two categories
  // are mutually exclusive, so each select shows its neutral "All" state when
  // the active value belongs to the other dimension. The separate Membership
  // Type select below writes its own `membershipType` param (DB membership
  // types) so Role and MembershipType are no longer conflated (#1445).
  const roleFilterIsNonMemberCategory = (
    NON_MEMBER_ROLE_VALUES as readonly string[]
  ).includes(filters.role)
  const getFilterDisplayValue = (key: string, value: string) => {
    if (key === "xeroContactGroup") {
      return (
        xeroContactGroupsList.find((group) => group.id === value)?.name ?? value
      )
    }
    if (key === "membershipType") {
      if (value === UNASSIGNED_MEMBERSHIP_TYPE_VALUE) return "Unassigned"
      return (
        membershipTypeOptions.find((type) => type.id === value)?.name ?? value
      )
    }
    return filterValueLabels[key as keyof Filters]?.[value] ?? value
  }

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
          value={roleFilterIsNonMemberCategory ? "all" : filters.role || "all"}
          onValueChange={(value) => onSetFilter("role", value === "all" ? "" : value)}
        >
          <SelectTrigger className="w-[160px]" aria-label="Filter by access role">
            <SelectValue placeholder="Access Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Access Roles</SelectItem>
            {roleOptions.map((option) => (
              <SelectItem key={option.token} value={option.token}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={roleFilterIsNonMemberCategory ? filters.role : "all"}
          onValueChange={(value) => onSetFilter("role", value === "all" ? "" : value)}
        >
          <SelectTrigger className="w-[175px]" aria-label="Filter by non-member category">
            <SelectValue placeholder="Non-Member Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Non-Member Categories</SelectItem>
            {NON_MEMBER_ROLE_VALUES.map((role) => (
              <SelectItem key={role} value={role}>
                {ROLE_LABELS[role]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.membershipType || "all"}
          onValueChange={(value) =>
            onSetFilter("membershipType", value === "all" ? "" : value)
          }
        >
          <SelectTrigger className="w-[175px]" aria-label="Filter by membership type">
            <SelectValue placeholder="Membership Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Membership Types</SelectItem>
            <SelectItem value={UNASSIGNED_MEMBERSHIP_TYPE_VALUE}>
              Unassigned
            </SelectItem>
            {membershipTypeOptions.map((type) => (
              <SelectItem key={type.id} value={type.id}>
                {type.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.lifecycleStatus || "nonArchived"}
          onValueChange={(value) =>
            onSetFilter("lifecycleStatus", value === "nonArchived" ? "" : value)
          }
        >
          <SelectTrigger className="w-[155px]" aria-label="Filter by member status">
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
          <SelectTrigger className="w-[130px]" aria-label="Filter by age tier">
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
          <SelectTrigger className="w-[150px]" aria-label="Filter by family group">
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
          <SelectTrigger className="w-[165px]" aria-label="Filter by login access">
            <SelectValue placeholder="Login Access" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Login Access</SelectItem>
            {(Object.keys(LOGIN_STAGE_LABELS) as MemberLoginStage[]).map((stage) => (
              <SelectItem key={stage} value={LOGIN_STAGE_FILTER_VALUES[stage]}>
                {LOGIN_STAGE_LABELS[stage]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.xeroLinked || "all"}
          onValueChange={(value) => onSetFilter("xeroLinked", value === "all" ? "" : value)}
        >
          <SelectTrigger className="w-[130px]" aria-label="Filter by Xero link">
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
          <SelectTrigger className="w-[170px]" aria-label="Filter by subscription">
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
            <SelectTrigger className="w-[170px]" aria-label="Filter by Xero contact group">
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
