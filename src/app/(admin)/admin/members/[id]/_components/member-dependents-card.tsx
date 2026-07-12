"use client"

import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Trash2 } from "lucide-react"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import {
  formatMemberDateNz,
  parentLinkTypeLabel,
} from "@/lib/admin-member-detail-helpers"
import { formatAgeTierName } from "@/lib/use-age-tier-options"
import type { MemberDetail } from "../_types"

interface MemberDependentsCardProps {
  member: MemberDetail
  isAdultMember: boolean
  memberIsArchived: boolean
  currentMemberPath: string
  unlinkingDependentId: string | null
  onOpenDependentDialog: () => void
  onUnlinkDependent: (parentId: string, dependentId: string, dependentName: string) => void
  className?: string
}

export function MemberDependentsCard({
  member,
  isAdultMember,
  memberIsArchived,
  currentMemberPath,
  unlinkingDependentId,
  onOpenDependentDialog,
  onUnlinkDependent,
  className,
}: MemberDependentsCardProps) {
  const router = useRouter()

  return (
    <Card className={className}>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base font-medium">Dependents</CardTitle>
        {isAdultMember && !memberIsArchived && (
          <Button variant="outline" size="sm" onClick={onOpenDependentDialog}>
            <Plus className="h-4 w-4 mr-1" />
            Add Dependent
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {member.dependents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {isAdultMember
              ? "No dependents linked to this member yet."
              : "Only adult members can manage dependents."}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Link</TableHead>
                <TableHead>Age Tier</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date of Birth</TableHead>
                <TableHead>Login</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {member.dependents.map((dependent) => (
                <TableRow key={dependent.id}>
                  <TableCell className="font-medium">
                    {dependent.firstName} {dependent.lastName}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{parentLinkTypeLabel(dependent.parentLinkType)}</Badge>
                  </TableCell>
                  <TableCell>
                    {formatAgeTierName(dependent.ageTier)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={dependent.active ? "default" : "destructive"}
                      className={
                        dependent.active ? "border-success/20 bg-success-muted text-success hover:shadow-md" : ""
                      }
                    >
                      {dependent.active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell>{dependent.dateOfBirth ? formatMemberDateNz(dependent.dateOfBirth) : "-"}</TableCell>
                  <TableCell>
                    {dependent.canLogin ? (
                      <Badge variant="secondary" className="border-border bg-muted text-foreground">
                        Can Login
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="border-info/20 bg-info-muted text-info">
                        Non-Login
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          router.push(buildHrefWithReturnTo(`/admin/members/${dependent.id}`, currentMemberPath))
                        }
                      >
                        View
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          onUnlinkDependent(
                            member.id,
                            dependent.id,
                            `${dependent.firstName} ${dependent.lastName}`
                          )
                        }
                        disabled={unlinkingDependentId === dependent.id}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        {unlinkingDependentId === dependent.id ? "Removing..." : "Remove"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
