"use client"

import Link from "next/link"
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  MemberPasswordActionButton,
} from "@/components/admin/member-password-action-button"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { getLifecycleStatusConfig } from "@/lib/admin-member-badges"
import {
  getMemberLoginStage,
  LOGIN_STAGE_LABELS,
} from "@/lib/member-login-stage"
import { deriveUserType, USER_TYPE_LABELS } from "@/lib/access-roles"
import { memberName } from "@/lib/member-serialization"
import type { Member } from "../_types"
import { formatTypeTierLabel, subscriptionStatusConfig } from "../_utils"

interface MemberTableProps {
  members: Member[]
  loading: boolean
  debouncedSearch: string
  selectedIds: Set<string>
  canEdit?: boolean
  sortBy: string
  sortDir: "asc" | "desc"
  membersListPath: string
  onToggleSelect: (id: string) => void
  onToggleSelectAll: () => void
  onToggleSort: (column: string) => void
  onOpenPasswordActionDialog: (ids: string[], label: string) => void
  onEditMember: (member: Member) => void
}

function SortIcon({
  column,
  sortBy,
  sortDir,
}: {
  column: string
  sortBy: string
  sortDir: "asc" | "desc"
}) {
  if (sortBy !== column) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />
  return sortDir === "asc" ? (
    <ArrowUp className="h-3 w-3 ml-1" />
  ) : (
    <ArrowDown className="h-3 w-3 ml-1" />
  )
}

// Sortable headers must be keyboard-operable and expose their sort state: a bare
// <th onClick> can't be tabbed to or activated with Enter/Space, and gives a
// screen reader no aria-sort. Render a real <button> inside a <th aria-sort>.
function SortableHeader({
  column,
  label,
  sortBy,
  sortDir,
  onToggleSort,
}: {
  column: string
  label: string
  sortBy: string
  sortDir: "asc" | "desc"
  onToggleSort: (column: string) => void
}) {
  const ariaSort =
    sortBy === column ? (sortDir === "asc" ? "ascending" : "descending") : "none"
  return (
    <TableHead aria-sort={ariaSort} className="select-none">
      <button
        type="button"
        onClick={() => onToggleSort(column)}
        className="inline-flex items-center rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
        <SortIcon column={column} sortBy={sortBy} sortDir={sortDir} />
      </button>
    </TableHead>
  )
}

export function MemberTable({
  members,
  loading,
  debouncedSearch,
  selectedIds,
  canEdit = true,
  sortBy,
  sortDir,
  membersListPath,
  onToggleSelect,
  onToggleSelectAll,
  onToggleSort,
  onOpenPasswordActionDialog,
  onEditMember,
}: MemberTableProps) {
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading members…" />
      </div>
    )
  }

  if (members.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title={
          debouncedSearch
            ? `No members match "${debouncedSearch}"`
            : "No members yet"
        }
        description={
          debouncedSearch
            ? "Try a different name or email, or clear the search to see everyone."
            : "Members you add will appear here."
        }
      />
    )
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {canEdit ? (
              <TableHead className="w-10">
                <span className="sr-only">Select</span>
                <input
                  type="checkbox"
                  aria-label="Select all members on this page"
                  checked={selectedIds.size === members.length && members.length > 0}
                  onChange={onToggleSelectAll}
                  className="h-4 w-4 rounded border-gray-300"
                />
              </TableHead>
            ) : null}
            {[
              ["name", "Name"],
              ["email", "Email"],
              // Access shows the member's derived type plus their single login
              // stage. The login stage is derived (no sortable DB column), so
              // this header sorts by the stored `role` — an approximation of
              // type order — rather than the rendered stage.
              ["role", "Access"],
            ].map(([column, label]) => (
              <SortableHeader
                key={column}
                column={column}
                label={label}
                sortBy={sortBy}
                sortDir={sortDir}
                onToggleSort={onToggleSort}
              />
            ))}
            {/*
              Combined "Type – Tier" column (#1445): the current-season
              membership type followed by the age tier (e.g. "Full – Adult").
              The column leads with Type, but sorts by `ageTier` — the type
              comes from a filtered to-many relation (the current-season
              SeasonalMembershipAssignment) that Prisma cannot cleanly orderBy,
              whereas ageTier is a real, whitelisted sortable Member column. The
              separate Membership Type and Age Tier filters remain distinct.
            */}
            <SortableHeader
              column="ageTier"
              label="Type – Tier"
              sortBy={sortBy}
              sortDir={sortDir}
              onToggleSort={onToggleSort}
            />
            <SortableHeader
              column="active"
              label="Status"
              sortBy={sortBy}
              sortDir={sortDir}
              onToggleSort={onToggleSort}
            />
            <TableHead>Family Group</TableHead>
            <TableHead>Subscription</TableHead>
            <TableHead>Xero</TableHead>
            <SortableHeader
              column="createdAt"
              label="Joined"
              sortBy={sortBy}
              sortDir={sortDir}
              onToggleSort={onToggleSort}
            />
            {canEdit ? <TableHead className="text-right">Actions</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => {
            const lifecycleConfig = getLifecycleStatusConfig(member)
            // One Access column (#1444): the member's derived type plus their
            // single login-journey stage. The no-login case renders just "No
            // login" (no type prefix); every login-on stage renders
            // "{Type} · {Stage}", e.g. "Admin · Invited".
            const loginStage = getMemberLoginStage(member)
            const userType = deriveUserType(member.accessRoles, member.canLogin)
            const accessTypeLabel =
              userType === "lodge" ? "Lodge" : USER_TYPE_LABELS[userType]
            const accessLabel =
              loginStage === "no-login"
                ? LOGIN_STAGE_LABELS["no-login"]
                : `${accessTypeLabel} · ${LOGIN_STAGE_LABELS[loginStage]}`
            const subscriptionConfig =
              subscriptionStatusConfig[member.subscriptionStatus ?? "NONE"] ||
              subscriptionStatusConfig.NOT_INVOICED
            const subscriptionBadge = (
              <Badge
                variant="secondary"
                className={`${subscriptionConfig.className} ${
                  member.subscriptionXeroInvoiceId
                    ? "cursor-pointer inline-flex items-center gap-1"
                    : ""
                }`}
              >
                {subscriptionConfig.label}
                {member.subscriptionXeroInvoiceId && <ExternalLink className="h-3 w-3" />}
              </Badge>
            )
            const name = memberName(member)

            return (
              <TableRow key={member.id} className="hover:bg-slate-50">
                {canEdit ? (
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`Select ${name}`}
                      checked={selectedIds.has(member.id)}
                      onChange={() => onToggleSelect(member.id)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </TableCell>
                ) : null}
                <TableCell className="font-medium">
                  <Link
                    href={buildHrefWithReturnTo(`/admin/members/${member.id}`, membersListPath)}
                    className="text-blue-600 hover:underline"
                  >
                    {name}
                  </Link>
                  {member.forcePasswordChange && (
                    <Badge variant="destructive" className="ml-2 text-xs">
                      PW Reset
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-slate-600">{member.email}</TableCell>
                <TableCell>
                  <Badge
                    variant={userType === "admin" ? "default" : "secondary"}
                    className={
                      userType === "admin"
                        ? "bg-blue-600 text-white hover:bg-blue-700"
                        : ""
                    }
                  >
                    {accessLabel}
                  </Badge>
                </TableCell>
                <TableCell>
                  {/* Display-only combination; data stays separate (#1445). */}
                  <span className="text-sm text-slate-600 whitespace-nowrap">
                    {formatTypeTierLabel(
                      member.currentMembershipType?.name,
                      member.ageTier,
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={lifecycleConfig.label === "Inactive" ? "destructive" : "secondary"}
                    className={lifecycleConfig.className}
                  >
                    {lifecycleConfig.label}
                  </Badge>
                </TableCell>
                <TableCell>
                  {member.familyGroups && member.familyGroups.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {member.familyGroups.map((familyGroup) =>
                        canEdit ? (
                          <Link
                            key={familyGroup.id}
                            href={`/admin/family-groups?edit=${familyGroup.id}`}
                          >
                            <Badge
                              variant="secondary"
                              className="bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 cursor-pointer"
                            >
                              {familyGroup.name || "Unnamed Group"}
                            </Badge>
                          </Link>
                        ) : (
                          <Badge
                            key={familyGroup.id}
                            variant="secondary"
                            className="bg-indigo-50 text-indigo-700 border-indigo-200"
                          >
                            {familyGroup.name || "Unnamed Group"}
                          </Badge>
                        )
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">-</span>
                  )}
                </TableCell>
                <TableCell>
                  {member.subscriptionXeroInvoiceId ? (
                    <a
                      href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${member.subscriptionXeroInvoiceId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {subscriptionBadge}
                    </a>
                  ) : (
                    subscriptionBadge
                  )}
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    {member.xeroContactId ? (
                      <a
                        href={`https://go.xero.com/app/contacts/contact/${member.xeroContactId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Badge
                          variant="secondary"
                          className="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer inline-flex items-center gap-1"
                        >
                          Linked
                          <ExternalLink className="h-3 w-3" />
                        </Badge>
                      </a>
                    ) : (
                      <span className="text-xs text-slate-400">-</span>
                    )}
                    {member.xeroContactGroups.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {member.xeroContactGroups.map((group) => (
                          <Badge
                            key={group.id}
                            variant="secondary"
                            className="bg-emerald-50 text-emerald-700 border-emerald-200"
                          >
                            {group.name}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {member.xeroContactId && !member.xeroContactGroupsLoaded && (
                      <p className="text-xs text-slate-400">Cached groups not refreshed yet</p>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-slate-500 text-sm">
                  {new Date(member.joinedDate || member.createdAt).toLocaleDateString("en-NZ", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </TableCell>
                {canEdit ? (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <MemberPasswordActionButton
                        member={member}
                        onClick={() => onOpenPasswordActionDialog([member.id], name)}
                      />
                      <Button variant="outline" size="sm" onClick={() => onEditMember(member)}>
                        Edit
                      </Button>
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
