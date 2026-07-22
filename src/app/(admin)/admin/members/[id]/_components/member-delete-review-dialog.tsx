"use client"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type {
  MemberDeleteEligibilityBlocker,
  MemberLifecycleActionRequest,
} from "../_types"

interface MemberDeleteReviewDialogProps {
  dialog: { request: MemberLifecycleActionRequest; action: "approve" | "reject" } | null
  approvalBlockers: MemberDeleteEligibilityBlocker[]
  reviewNote: string
  error: string
  submitting: boolean
  onClose: () => void
  onChangeReviewNote: (value: string) => void
  onSubmit: () => void
}

export function MemberDeleteReviewDialog({
  dialog,
  approvalBlockers,
  reviewNote,
  error,
  submitting,
  onClose,
  onChangeReviewNote,
  onSubmit,
}: MemberDeleteReviewDialogProps) {
  const action = dialog?.action
  return (
    <Dialog
      open={Boolean(dialog)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {action === "approve" ? "Approve Member Delete" : "Reject Member Delete"}
          </DialogTitle>
          <DialogDescription>
            {action === "approve"
              ? "Approval permanently deletes the member record after storing the snapshot on the request."
              : "Rejecting keeps the member record unchanged."}
          </DialogDescription>
        </DialogHeader>
        {error && <div className="rounded border border-danger-6 bg-danger-3 p-2 text-sm text-danger-11">{error}</div>}
        {action === "approve" && approvalBlockers.length > 0 && (
          <div className="rounded border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
            Approval is blocked until these dependencies are cleared:
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {approvalBlockers.map((blocker) => (
                <li key={blocker.code}>
                  {blocker.label}
                  {typeof blocker.count === "number" ? ` (${blocker.count})` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="delete-review-note">Review note</Label>
          <Textarea
            id="delete-review-note"
            value={reviewNote}
            onChange={(event) => onChangeReviewNote(event.target.value)}
            placeholder={action === "approve" ? "Approved after eligibility check" : "Reason for rejection"}
            rows={4}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant={action === "approve" ? "destructive" : "default"}
            onClick={onSubmit}
            disabled={submitting || (action === "approve" && approvalBlockers.length > 0)}
          >
            {submitting
              ? "Processing..."
              : action === "approve"
                ? "Approve Delete"
                : "Reject Request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
