"use client"

import Link from "next/link"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Archive } from "lucide-react"
import { formatMemberDateNz } from "@/lib/admin-member-detail-helpers"
import type {
  MemberDetail,
  MemberLifecycleActionRequest,
  OpenCancellationRequestSummary,
} from "../_types"

interface MemberLifecycleCardProps {
  member: MemberDetail
  pendingArchiveRequest: MemberLifecycleActionRequest | null
  reviewedArchiveRequests: MemberLifecycleActionRequest[]
  isArchiveRequester: boolean
  canRequestArchive: boolean
  canRequestCancellation: boolean
  openCancellationRequest: OpenCancellationRequestSummary | null
  archiveError: string
  archiveReason: string
  archiveReviewNotes: Record<string, string>
  archiveActionLoading: string | null
  cancellationError: string
  cancellationReason: string
  cancellationSubmitting: boolean
  onChangeArchiveReason: (value: string) => void
  onChangeArchiveReviewNote: (requestId: string, value: string) => void
  onChangeCancellationReason: (value: string) => void
  onSubmitArchive: () => void
  onSubmitCancellation: () => void
  onReviewArchive: (
    requestId: string,
    action: "approve" | "reject",
    notifyMember?: boolean,
  ) => void
  className?: string
}

export function MemberLifecycleCard({
  member,
  pendingArchiveRequest,
  reviewedArchiveRequests,
  isArchiveRequester,
  canRequestArchive,
  canRequestCancellation,
  openCancellationRequest,
  archiveError,
  archiveReason,
  archiveReviewNotes,
  archiveActionLoading,
  cancellationError,
  cancellationReason,
  cancellationSubmitting,
  onChangeArchiveReason,
  onChangeArchiveReviewNote,
  onChangeCancellationReason,
  onSubmitArchive,
  onSubmitCancellation,
  onReviewArchive,
  className,
}: MemberLifecycleCardProps) {
  // #1788: which archive review is waiting on the admin's notify-or-not choice.
  // The dialog only opens when an email would actually send (the target member
  // has an address on file); a member with no email reviews directly with no
  // flag. The choice is kept set while the dialog fades out (Radix keeps the
  // content mounted through its exit animation) so the copy never flickers.
  const memberHasEmail = Boolean(member.email)
  const [notifyChoice, setNotifyChoice] = useState<{
    requestId: string
    action: "approve" | "reject"
  } | null>(null)
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false)

  function startReview(requestId: string, action: "approve" | "reject") {
    if (memberHasEmail) {
      setNotifyChoice({ requestId, action })
      setNotifyDialogOpen(true)
    } else {
      // Nothing to email — perform directly, no notify flag, no dialog.
      onReviewArchive(requestId, action)
    }
  }

  // #1788: dispatch the pending choice. Close the dialog without clearing the
  // choice so the content keeps its wording while it fades out.
  function confirmNotify(notifyMember: boolean) {
    const choice = notifyChoice
    setNotifyDialogOpen(false)
    if (!choice) return
    onReviewArchive(choice.requestId, choice.action, notifyMember)
  }

  const isReviewing = Boolean(archiveActionLoading)

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Archive className="h-4 w-4 text-slate-500" />
          Lifecycle
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {archiveError && (
          <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{archiveError}</div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-md border border-slate-200 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Cancellation</p>
            {member.cancelledAt ? (
              <div className="mt-2 space-y-1 text-sm">
                <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-amber-200">
                  Cancelled {formatMemberDateNz(member.cancelledAt)}
                </Badge>
                {member.cancelledReason && <p className="text-slate-600">{member.cancelledReason}</p>}
              </div>
            ) : openCancellationRequest ? (
              <p className="mt-2 text-sm text-amber-700">Cancellation request pending review.</p>
            ) : (
              <p className="mt-2 text-sm text-slate-600">This member has not been cancelled.</p>
            )}
          </div>
          <div className="rounded-md border border-slate-200 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Archive</p>
            {member.archivedAt ? (
              <div className="mt-2 space-y-1 text-sm">
                <Badge variant="secondary" className="bg-slate-200 text-slate-800 border-slate-300">
                  Archived {formatMemberDateNz(member.archivedAt)}
                </Badge>
                {member.archivedReason && <p className="text-slate-600">{member.archivedReason}</p>}
              </div>
            ) : pendingArchiveRequest ? (
              <p className="mt-2 text-sm text-amber-700">Archive request pending review.</p>
            ) : (
              <p className="mt-2 text-sm text-slate-600">
                {member.cancelledAt ? "Ready to request archive." : "Archive is available after cancellation."}
              </p>
            )}
          </div>
        </div>

        {cancellationError && (
          <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{cancellationError}</div>
        )}

        {openCancellationRequest && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-950">Pending cancellation request</p>
              {openCancellationRequest.reason && (
                <p className="text-sm text-amber-900">{openCancellationRequest.reason}</p>
              )}
              <p className="text-xs text-amber-800">
                Requested by {openCancellationRequest.requestedBy?.name ?? "Unknown"} on{" "}
                {formatMemberDateNz(openCancellationRequest.submittedAt)} ({openCancellationRequest.participantStatus.replace(/_/g, " ").toLowerCase()})
              </p>
              <p className="text-xs text-amber-800">
                Review in the <Link href="/admin/membership-cancellations" className="underline">cancellation review queue</Link>.
              </p>
            </div>
          </div>
        )}

        {canRequestCancellation && (
          <div className="rounded-md border border-slate-200 p-4">
            <div className="space-y-2">
              <Label htmlFor="cancellation-reason">Cancellation reason *</Label>
              <textarea
                id="cancellation-reason"
                value={cancellationReason}
                onChange={(event) => onChangeCancellationReason(event.target.value)}
                rows={3}
                maxLength={1000}
                className="min-h-24 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <p className="text-xs text-slate-500">
                Admin-initiated cancellation requests go directly to the review queue without requiring the member to confirm by email.
              </p>
            </div>
            <Button className="mt-3" size="sm" onClick={onSubmitCancellation} disabled={cancellationSubmitting}>
              {cancellationSubmitting ? "Submitting..." : "Request Cancellation"}
            </Button>
          </div>
        )}

        {pendingArchiveRequest && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium text-amber-950">Pending archive request</p>
                <p className="text-sm text-amber-900">{pendingArchiveRequest.reason}</p>
                <p className="text-xs text-amber-800">
                  Requested by {pendingArchiveRequest.requestedBy?.name ?? "Unknown admin"} on{" "}
                  {formatMemberDateNz(pendingArchiveRequest.requestedAt)}
                </p>
              </div>
              {isArchiveRequester ? (
                <p className="text-xs text-amber-800">Needs another admin to approve or reject.</p>
              ) : (
                <div className="w-full space-y-2 sm:max-w-sm">
                  <Label htmlFor={`archive-review-note-${pendingArchiveRequest.id}`}>Optional review note</Label>
                  <textarea
                    id={`archive-review-note-${pendingArchiveRequest.id}`}
                    value={archiveReviewNotes[pendingArchiveRequest.id] ?? ""}
                    onChange={(event) => onChangeArchiveReviewNote(pendingArchiveRequest.id, event.target.value)}
                    rows={2}
                    maxLength={1000}
                    className="min-h-20 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={Boolean(archiveActionLoading)}
                      onClick={() => startReview(pendingArchiveRequest.id, "reject")}
                    >
                      {archiveActionLoading === `reject:${pendingArchiveRequest.id}` ? "Rejecting..." : "Reject"}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={Boolean(archiveActionLoading)}
                      onClick={() => startReview(pendingArchiveRequest.id, "approve")}
                    >
                      {archiveActionLoading === `approve:${pendingArchiveRequest.id}` ? "Archiving..." : "Approve Archive"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {canRequestArchive && (
          <div className="rounded-md border border-slate-200 p-4">
            <div className="space-y-2">
              <Label htmlFor="archive-reason">Archive reason *</Label>
              <textarea
                id="archive-reason"
                value={archiveReason}
                onChange={(event) => onChangeArchiveReason(event.target.value)}
                rows={3}
                maxLength={1000}
                className="min-h-24 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <p className="text-xs text-slate-500">
                A different admin must approve this request before the member is archived.
              </p>
            </div>
            <Button
              className="mt-3"
              size="sm"
              onClick={onSubmitArchive}
              disabled={archiveActionLoading === "request"}
            >
              <Archive className="h-4 w-4 mr-1" />
              {archiveActionLoading === "request" ? "Submitting..." : "Request Archive"}
            </Button>
          </div>
        )}

        {reviewedArchiveRequests.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-900">Recent archive decisions</p>
            <div className="space-y-2">
              {reviewedArchiveRequests.map((request) => (
                <div key={request.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="secondary"
                      className={
                        request.status === "APPROVED"
                          ? "bg-slate-200 text-slate-800 border-slate-300"
                          : "bg-red-50 text-red-700 border-red-200"
                      }
                    >
                      {request.status === "APPROVED" ? "Approved" : "Rejected"}
                    </Badge>
                    <span className="text-slate-600">
                      {request.reviewedAt ? formatMemberDateNz(request.reviewedAt) : "Not dated"} by{" "}
                      {request.reviewedBy?.name ?? "Unknown admin"}
                    </span>
                  </div>
                  {request.reviewNote && <p className="mt-1 text-slate-600">{request.reviewNote}</p>}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      {/* #1788: per-review member-email choice, mirroring the #1705/#1769a
          pattern. Shown only when the target member has an address on file;
          both choices complete the review and the choice is recorded in the
          audit log. Archive approve and reject are handled identically — only
          the wording changes. */}
      <Dialog
        open={notifyDialogOpen}
        onOpenChange={(open) => {
          if (!open && !isReviewing) setNotifyDialogOpen(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {notifyChoice?.action === "approve"
                ? "Email the member about this archive?"
                : "Email the member about this decision?"}
            </DialogTitle>
            <DialogDescription>
              {notifyChoice?.action === "approve"
                ? "The member is archived either way. Choose whether they receive the standard archive-completed email — your choice is recorded in the audit log."
                : "The archive request is rejected either way. Choose whether the member receives the standard rejection email — your choice is recorded in the audit log."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={isReviewing}
              onClick={() => confirmNotify(false)}
            >
              {notifyChoice?.action === "approve"
                ? "Archive without emailing"
                : "Reject without emailing"}
            </Button>
            <Button
              variant={notifyChoice?.action === "approve" ? "destructive" : "default"}
              disabled={isReviewing}
              onClick={() => confirmNotify(true)}
            >
              {notifyChoice?.action === "approve"
                ? "Archive and email member"
                : "Reject and email member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
