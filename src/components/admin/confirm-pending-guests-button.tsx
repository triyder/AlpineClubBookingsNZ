"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/confirm-dialog";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { formatCents } from "@/lib/utils";

interface ConfirmPendingGuestsButtonProps {
  bookingId: string;
  hasSavedPaymentMethod: boolean;
  finalPriceCents: number;
}

export function ConfirmPendingGuestsButton({
  bookingId,
  hasSavedPaymentMethod,
  finalPriceCents,
}: ConfirmPendingGuestsButtonProps) {
  const router = useRouter();
  // Writes /api/admin/bookings/[id]/confirm-pending-guests (bookings area). A
  // view-only bookings admin sees the action disabled (#1997); the notify
  // dialog is unreachable behind it.
  const canEdit = useAdminAreaEditAccess("bookings");
  const { confirm, confirmDialog } = useConfirm();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  // #1769b: the admin's explicit email-choice dialog, shown only when this
  // confirmation would actually send the member a confirmation email.
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);

  // Mirror the server's branch order: a zero-dollar booking is confirmed at no
  // charge regardless of a card on file; otherwise a saved card is charged, and
  // without one the booking moves to payment-owed.
  const isZeroDollar = finalPriceCents === 0;
  const willCharge = !isZeroDollar && hasSavedPaymentMethod;
  // #1769b honesty rule: the confirmation email sends when the booking becomes
  // PAID — the zero-dollar (paid_zero) and charged-card (paid_charged) paths.
  // The priced-without-card path moves to payment-owed and emails no one, so it
  // skips the notify dialog and confirms directly.
  const willEmail = isZeroDollar || hasSavedPaymentMethod;
  const consequence = isZeroDollar
    ? "This will confirm the booking at no charge."
    : hasSavedPaymentMethod
      ? `The member's saved card will be charged ${formatCents(finalPriceCents)}.`
      : "This will move the booking to payment-owed (no card on file).";

  async function handleConfirm() {
    const confirmed = await confirm({
      title: "Confirm pending guests?",
      description: `${consequence} This locks the non-member guests in and clears the hold so the booking won't be bumped.`,
      confirmLabel: willCharge ? "Charge and confirm" : "Confirm",
    });
    if (!confirmed) return;

    // When a confirmation email would be sent, ask the admin whether to send
    // it; otherwise confirm directly (today's behaviour on the no-email path).
    if (willEmail) {
      setNotifyDialogOpen(true);
      return;
    }
    void performConfirm();
  }

  async function performConfirm(notifyMember?: boolean) {
    setConfirming(true);
    setError("");

    try {
      const res = await fetch(
        `/api/admin/bookings/${bookingId}/confirm-pending-guests`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            notifyMember !== undefined ? { notifyMember } : {}
          ),
        }
      );

      if (res.ok) {
        toast.success(
          notifyMember === false
            ? "Pending guests confirmed. The member was not emailed."
            : "Pending guests confirmed."
        );
        router.refresh();
        return;
      }

      const data = await res.json().catch(() => ({}));
      const message =
        data.error === "CAPACITY_EXCEEDED"
          ? "Not enough beds remain for these dates. Use Force confirm to overbook if intended."
          : data.error || "Failed to confirm pending guests";
      setError(message);
      toast.error(message);
      setConfirming(false);
    } catch {
      const message = "Failed to confirm pending guests";
      setError(message);
      toast.error(message);
      setConfirming(false);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the card so the empty
    wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view this booking but cannot confirm its pending
      guests. Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <Card>
      {confirmDialog}
      <CardHeader>
        <CardTitle>Confirm pending guests now</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-600">
          This booking still has non-member guests on hold. Confirming now locks
          the guests in and clears the hold so the booking won&apos;t be bumped.
          {isZeroDollar
            ? " There is no charge for this booking."
            : hasSavedPaymentMethod
              ? ` The member's saved card will be charged ${formatCents(finalPriceCents)}.`
              : " There is no saved card, so the booking will move to payment-owed for payment to be arranged separately."}
        </p>
        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <ViewOnlyActionButton
          canEdit={canEdit}
          describeReason={false}
          onClick={handleConfirm}
          disabled={confirming}
        >
          {confirming ? "Confirming..." : "Confirm pending guests"}
        </ViewOnlyActionButton>
      </CardContent>

      {/* #1769b (#1705 pattern): the admin chooses, per confirmation, whether
          the member is emailed. Both choices confirm the booking identically;
          the choice itself is recorded in the audit log. Shown only when a
          confirmation email would actually be sent. */}
      <Dialog open={notifyDialogOpen} onOpenChange={setNotifyDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email the member about this confirmation?</DialogTitle>
            <DialogDescription>
              The booking will be confirmed either way{willCharge
                ? ", and the saved card is charged regardless"
                : ""}. Choose whether the member receives the standard booking
              confirmation email — your choice is recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setNotifyDialogOpen(false);
                void performConfirm(false);
              }}
            >
              Confirm without emailing
            </Button>
            <Button
              onClick={() => {
                setNotifyDialogOpen(false);
                void performConfirm(true);
              }}
            >
              Confirm and email member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </Card>
    </div>
  );
}
