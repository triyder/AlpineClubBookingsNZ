"use client"

import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Link2, Trash2 } from "lucide-react"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { parentLinkTypeLabel } from "@/lib/admin-member-detail-helpers"
import type { MemberDetail } from "../_types"

interface MemberParentLinksCardProps {
  member: MemberDetail
  memberIsArchived: boolean
  currentMemberPath: string
  unlinkingDependentId: string | null
  onOpenParentLinkDialog: () => void
  onUnlinkParent: (parentId: string, dependentId: string, dependentName: string) => void
}

export function MemberParentLinksCard({
  member,
  memberIsArchived,
  currentMemberPath,
  unlinkingDependentId,
  onOpenParentLinkDialog,
  onUnlinkParent,
}: MemberParentLinksCardProps) {
  const router = useRouter()
  const parentLinkCount = member.parentLinks?.length ?? 0

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base font-medium">Parent Links</CardTitle>
        {memberIsArchived ? (
          <Badge variant="secondary" className="bg-slate-200 text-slate-800 border-slate-300">
            Archived
          </Badge>
        ) : parentLinkCount < 2 ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenParentLinkDialog}
            disabled={member.dependents.length > 0}
            title={
              member.dependents.length > 0
                ? "Members with dependants cannot be linked under another parent."
                : undefined
            }
          >
            <Link2 className="h-4 w-4 mr-1" />
            {parentLinkCount === 0 ? "Add Parent" : "Add Second Parent"}
          </Button>
        ) : (
          <Badge variant="secondary" className="bg-slate-100 text-slate-700 border-slate-200">
            Two parents linked
          </Badge>
        )}
      </CardHeader>
      <CardContent>
        {parentLinkCount > 0 ? (
          <div className="space-y-3">
            {member.parentLinks.map((parent) => (
              <div
                key={parent.id}
                className="flex flex-col gap-3 rounded-md border border-slate-200 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-slate-900">
                      {parent.firstName} {parent.lastName}
                    </p>
                    <Badge variant="secondary">{parentLinkTypeLabel(parent.parentLinkType)}</Badge>
                    <Badge variant="secondary">{parent.ageTier}</Badge>
                    <Badge
                      variant={parent.active ? "default" : "destructive"}
                      className={
                        parent.active ? "bg-green-100 text-green-800 hover:bg-green-200 border-green-200" : ""
                      }
                    >
                      {parent.active ? "Active" : "Inactive"}
                    </Badge>
                    {member.inheritEmailFromId === parent.id ||
                    member.inheritEmailFromId === parent.inheritEmailFromId ? (
                      <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-amber-200">
                        Notification email
                      </Badge>
                    ) : null}
                    {parent.canLogin ? (
                      <Badge variant="secondary" className="bg-slate-100 text-slate-700 border-slate-200">
                        Can Login
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="bg-purple-100 text-purple-800 border-purple-200">
                        Non-Login
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-slate-500">{parent.email}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      router.push(buildHrefWithReturnTo(`/admin/members/${parent.id}`, currentMemberPath))
                    }
                  >
                    View Parent
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onUnlinkParent(parent.id, member.id, `${member.firstName} ${member.lastName}`)
                    }
                    disabled={unlinkingDependentId === member.id}
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    {unlinkingDependentId === member.id ? "Removing..." : "Remove"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-slate-500">No parent member linked.</p>
            {member.dependents.length > 0 && (
              <p className="text-xs text-slate-500">
                This member already has dependants, so they cannot be linked under another parent.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
