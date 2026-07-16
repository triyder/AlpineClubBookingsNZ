"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { UseXeroEntranceFeeDecisionResult } from "@/lib/admin-xero-entrance-fee"

interface MemberXeroEntranceFeeFieldsProps {
  idPrefix: string
  decision: UseXeroEntranceFeeDecisionResult
  onClearError: () => void
}

export function MemberXeroEntranceFeeFields({
  idPrefix,
  decision,
  onClearError,
}: MemberXeroEntranceFeeFieldsProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          id={`${idPrefix}-create-invoice`}
          checked={decision.xeroCreateEntranceFeeInvoice}
          onChange={(event) => {
            decision.setXeroCreateEntranceFeeInvoice(event.target.checked)
            onClearError()
          }}
          className="mt-0.5 h-4 w-4 rounded border-gray-300"
        />
        <div>
          <Label htmlFor={`${idPrefix}-create-invoice`}>
            Create membership joining fee invoice after contact creation
          </Label>
          <p className="text-xs text-muted-foreground">
            Leave this unchecked only when the invoice is being handled another way.
          </p>
        </div>
      </div>

      {decision.xeroCreateEntranceFeeInvoice ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-amount`}>Invoice amount override</Label>
            <Input
              id={`${idPrefix}-amount`}
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              placeholder="Use configured amount"
              value={decision.xeroEntranceFeeAmount}
              onChange={(event) => decision.setXeroEntranceFeeAmount(event.target.value)}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={`${idPrefix}-narration`}>Invoice narration</Label>
            <Textarea
              id={`${idPrefix}-narration`}
              value={decision.xeroEntranceFeeNarration}
              onChange={(event) => decision.setXeroEntranceFeeNarration(event.target.value)}
              maxLength={500}
              rows={2}
              placeholder="Optional description to use on the invoice line"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-skip-reason`}>
            Reason for not raising the joining fee invoice
          </Label>
          <Textarea
            id={`${idPrefix}-skip-reason`}
            value={decision.xeroEntranceFeeSkipReason}
            onChange={(event) => decision.setXeroEntranceFeeSkipReason(event.target.value)}
            maxLength={500}
            rows={2}
            placeholder="Required when no joining fee invoice will be queued"
          />
        </div>
      )}
    </div>
  )
}
