"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { LodgeInvoiceDetailField } from "@/lib/lodges";

export type LodgeInvoiceDetailValues = Record<LodgeInvoiceDetailField, string | null | undefined>;

/**
 * The lodge's invoice details (fork #115): postal address, the bank details
 * printed in the invoice's payment box, and the GST number. One component for
 * both editing surfaces — the single-lodge Lodge details panel on Club Identity
 * and the Admin → Lodges edit form (#123) — so their wording and layout cannot
 * drift (INV-SSOT-001). All four are optional and save through
 * `PATCH /api/admin/lodges/[id]`.
 */
export function LodgeInvoiceDetailsFields({
  idPrefix,
  values,
  onChange,
  disabled = false,
  describedBy,
}: {
  /** Prefix for the inputs' ids, unique on the page. */
  idPrefix: string;
  values: LodgeInvoiceDetailValues;
  onChange: (field: LodgeInvoiceDetailField, value: string) => void;
  disabled?: boolean;
  /** The view-only explanation's id, when the inputs are disabled for it. */
  describedBy?: string;
}) {
  const common = { disabled, "aria-describedby": describedBy };
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-postal`}>Postal address</Label>
        <Textarea
          id={`${idPrefix}-postal`}
          value={values.postalAddress ?? ""}
          rows={2}
          maxLength={300}
          placeholder="Optional — used on invoices instead of the address"
          {...common}
          onChange={(event) => onChange("postalAddress", event.target.value)}
        />
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Bank details for bookings</legend>
        <p className="text-sm text-muted-foreground">
          Optional. Shown in the payment box of the booking invoice.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-bank-name`}>Account name</Label>
          <Input
            id={`${idPrefix}-bank-name`}
            value={values.bankAccountName ?? ""}
            maxLength={200}
            {...common}
            onChange={(event) => onChange("bankAccountName", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-bank-details`}>Account details</Label>
          <Textarea
            id={`${idPrefix}-bank-details`}
            value={values.bankAccountDetails ?? ""}
            rows={2}
            maxLength={300}
            placeholder="Account number, and any other payment details"
            {...common}
            onChange={(event) => onChange("bankAccountDetails", event.target.value)}
          />
        </div>
      </fieldset>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-gst`}>GST number</Label>
        <Input
          id={`${idPrefix}-gst`}
          value={values.gstNumber ?? ""}
          maxLength={40}
          placeholder="Optional — printed on invoices when set"
          {...common}
          onChange={(event) => onChange("gstNumber", event.target.value)}
        />
      </div>
    </div>
  );
}
