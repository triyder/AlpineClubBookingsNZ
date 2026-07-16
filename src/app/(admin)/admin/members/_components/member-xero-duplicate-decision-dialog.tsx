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
import { XeroSuggestedContactCard } from "@/components/admin/xero-suggested-contact-card"
import type { PendingXeroCreateDecision } from "../_types"

interface MemberXeroDuplicateDecisionDialogProps {
  decision: PendingXeroCreateDecision | null
  selectedContactId: string
  error: string
  loading: boolean
  onSelectedContactChange: (contactId: string) => void
  onClose: () => void
  onLinkSelected: () => void
  onForceCreate: () => void
}

export function MemberXeroDuplicateDecisionDialog({
  decision,
  selectedContactId,
  error,
  loading,
  onSelectedContactChange,
  onClose,
  onLinkSelected,
  onForceCreate,
}: MemberXeroDuplicateDecisionDialogProps) {
  return (
    <Dialog open={Boolean(decision)} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review Similar Xero Contacts</DialogTitle>
          <DialogDescription>
            {decision
              ? `We found existing Xero contacts that may match ${decision.memberName}. Link one of these if appropriate, or create a brand-new contact anyway.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
            {error}
          </div>
        )}
        {decision && (
          <div className="space-y-3">
            <div className="max-h-[360px] overflow-y-auto space-y-2">
              {decision.suggestedContacts.map((contact) => (
                <XeroSuggestedContactCard
                  key={contact.contactId}
                  contact={contact}
                  radioName="pending-xero-contact"
                  checked={selectedContactId === contact.contactId}
                  onSelect={() => onSelectedContactChange(contact.contactId)}
                />
              ))}
            </div>
            {decision.entranceFeeInvoiceOptions.createEntranceFeeInvoice && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                If you choose <span className="font-medium">Create New Contact Anyway</span>,
                the membership joining fee invoice will also be queued.
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Do This Later
          </Button>
          <Button
            variant="outline"
            onClick={onLinkSelected}
            disabled={loading || !selectedContactId}
          >
            {loading ? "Working..." : "Link Selected Contact"}
          </Button>
          <Button onClick={onForceCreate} disabled={loading}>
            {loading ? "Working..." : "Create New Contact Anyway"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
