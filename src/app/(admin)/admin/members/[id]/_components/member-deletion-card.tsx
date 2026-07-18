"use client"

import { ViewOnlyActionButton } from "@/components/admin/view-only-action"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Trash2 } from "lucide-react"
import { formatMemberDateNz } from "@/lib/admin-member-detail-helpers"
import { cn } from "@/lib/utils"
import type {
  MemberDeleteEligibility,
  MemberLifecycleActionRequest,
} from "../_types"

interface MemberDeletionCardProps {
  deleteEligibility: MemberDeleteEligibility
  deleteRequests: MemberLifecycleActionRequest[]
  pendingDeleteRequest: MemberLifecycleActionRequest | undefined
  approvalBlockerCount: number
  canReviewPendingDeleteRequest: boolean
  onOpenRequestDialog: () => void
  onOpenReviewDialog: (
    request: MemberLifecycleActionRequest,
    action: "approve" | "reject"
  ) => void
  /** Whether the actor may act (membership edit, #1997). */
  canEdit?: boolean
  className?: string
}

const deleteStatusLabel: Record<MemberLifecycleActionRequest["status"], string> = {
  REQUESTED: "Pending review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
}

export function MemberDeletionCard({
  deleteEligibility,
  deleteRequests,
  pendingDeleteRequest,
  approvalBlockerCount,
  canReviewPendingDeleteRequest,
  onOpenRequestDialog,
  onOpenReviewDialog,
  canEdit = true,
  className,
}: MemberDeletionCardProps) {
  const deleteBlockers = deleteEligibility.blockers

  return (
    <Card className={cn("border-red-200", className)}>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-base font-medium">Member Deletion</CardTitle>
          <p className="mt-1 text-sm text-slate-500">
            Hard deletion is only available for records added in error with no meaningful history.
          </p>
        </div>
        <ViewOnlyActionButton
          canEdit={canEdit}
          variant="destructive"
          size="sm"
          onClick={onOpenRequestDialog}
          disabled={!deleteEligibility.eligible || Boolean(pendingDeleteRequest)}
        >
          <Trash2 className="h-4 w-4 mr-1" />
          Request Delete
        </ViewOnlyActionButton>
      </CardHeader>
      <CardContent className="space-y-4">
        {pendingDeleteRequest ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="font-medium">Delete request pending second-admin review</div>
            <div className="mt-1">
              Requested {formatMemberDateNz(pendingDeleteRequest.requestedAt)} by{" "}
              {pendingDeleteRequest.requestedBy?.name ?? "Unknown admin"}
            </div>
            <div className="mt-2 text-amber-800">{pendingDeleteRequest.reason}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <ViewOnlyActionButton
                canEdit={canEdit}
                size="sm"
                variant="destructive"
                onClick={() => onOpenReviewDialog(pendingDeleteRequest, "approve")}
                disabled={!canReviewPendingDeleteRequest || approvalBlockerCount > 0}
              >
                Approve Delete
              </ViewOnlyActionButton>
              <ViewOnlyActionButton
                canEdit={canEdit}
                size="sm"
                variant="outline"
                onClick={() => onOpenReviewDialog(pendingDeleteRequest, "reject")}
                disabled={!canReviewPendingDeleteRequest}
              >
                Reject
              </ViewOnlyActionButton>
              {!canReviewPendingDeleteRequest && (
                <span className="self-center text-xs text-amber-800">
                  Requester cannot approve or reject their own delete request.
                </span>
              )}
            </div>
          </div>
        ) : deleteEligibility.eligible ? (
          <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            This member has no delete blockers. A reason and second-admin approval are still required.
          </div>
        ) : (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            <div className="font-medium text-slate-900">Deletion is blocked</div>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {deleteBlockers.map((blocker) => (
                <li key={blocker.code}>
                  {blocker.label}
                  {typeof blocker.count === "number" ? ` (${blocker.count})` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        {deleteRequests.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Recent delete requests
            </div>
            <div className="divide-y divide-slate-200 rounded-md border border-slate-200">
              {deleteRequests.map((request) => (
                <div key={request.id} className="p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium text-slate-900">{deleteStatusLabel[request.status]}</div>
                    <div className="text-xs text-slate-500">{formatMemberDateNz(request.requestedAt)}</div>
                  </div>
                  <div className="mt-1 text-slate-600">{request.reason}</div>
                  {request.reviewNote && (
                    <div className="mt-1 text-xs text-slate-500">Review note: {request.reviewNote}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
