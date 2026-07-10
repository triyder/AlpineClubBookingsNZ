"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface CancelPreview {
  refundAmountCents: number;
  keptAmountCents: number;
  changeFeeCents: number;
  refundPercentage: number;
  creditRefundAmountCents: number;
  creditRefundPercentage: number;
  creditRestoredCents: number;
  totalPaidCents: number;
  hasPayment: boolean;
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function CancelBookingButton({
  bookingId,
  refundAppealDescription,
  onBehalfOfMember = false,
  canChooseMemberEmail = false,
}: {
  bookingId: string;
  refundAppealDescription?: string;
  // Issue #1303: when a Full Admin cancels a booking they don't own, this is an
  // explicit admin-on-behalf action (the only admin path to cancel a member's
  // booking). Re-frame the button label and confirm/success copy accordingly —
  // the cancel endpoint and settlement logic are unchanged.
  onBehalfOfMember?: boolean;
  // Issue #1705 (#1698 pattern): when true, Confirm Cancellation first asks
  // whether the member receives the cancellation email ("Cancel and email
  // member" / "Cancel without emailing"). Pass viewerRole === "ADMIN" for the
  // booking-management role (bookingManagementAuthorizationRole) — the same
  // role the cancel route resolves before honouring notifyMember — so the
  // dialog shows exactly when the server will honour the choice. A member
  // self-cancel keeps the immediate always-notify confirm.
  canChooseMemberEmail?: boolean;
}) {
  const [step, setStep] = useState<"idle" | "loading" | "preview" | "cancelling" | "success" | "error">("idle");
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [result, setResult] = useState<{ refundAmountCents: number; refundMethod: string; creditAmountCents?: number; creditRestoredCents?: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [refundMethod, setRefundMethod] = useState<"card" | "credit">("card");
  // Issue #1705: the admin's explicit email choice dialog, and the choice that
  // was made (null = no choice offered, i.e. always-notify member self-cancel).
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);
  const [notifiedMember, setNotifiedMember] = useState<boolean | null>(null);
  const router = useRouter();

  async function handleShowPreview() {
    setStep("loading");
    try {
      const res = await fetch(`/api/bookings/${bookingId}/cancel-preview`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error || "Failed to load cancellation details");
        setStep("error");
        return;
      }
      const data: CancelPreview = await res.json();
      setPreview(data);
      setRefundMethod("card");
      setStep("preview");
    } catch {
      setErrorMsg("Failed to load cancellation details");
      setStep("error");
    }
  }

  // Issue #1705 (#1698 pattern): an admin/booking-officer confirm goes through
  // the notify dialog first; the dialog's two actions call performCancel with
  // the explicit email choice. A member self-cancel calls performCancel with no
  // argument and always notifies (the server 403s the flag from non-admins).
  function handleConfirmCancel() {
    if (canChooseMemberEmail) {
      setNotifyDialogOpen(true);
      return;
    }
    void performCancel();
  }

  async function performCancel(notifyMemberChoice?: boolean) {
    setStep("cancelling");
    setNotifiedMember(notifyMemberChoice ?? null);
    try {
      const body: { refundMethod: "card" | "credit"; notifyMember?: boolean } = {
        refundMethod,
      };
      if (notifyMemberChoice !== undefined) {
        body.notifyMember = notifyMemberChoice;
      }
      const res = await fetch(`/api/bookings/${bookingId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setResult({
          refundAmountCents: data.refundAmountCents || 0,
          refundMethod: data.refundMethod || "card",
          creditAmountCents: data.creditAmountCents,
          creditRestoredCents: data.creditRestoredCents,
        });
        setStep("success");
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error || "Failed to cancel booking");
        setStep("error");
      }
    } catch {
      setErrorMsg("Failed to cancel booking");
      setStep("error");
    }
  }

  if (step === "idle") {
    return (
      <Button variant="destructive" onClick={handleShowPreview}>
        {onBehalfOfMember ? "Cancel on behalf of member" : "Cancel Booking"}
      </Button>
    );
  }

  if (step === "loading") {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm text-slate-500">Loading cancellation details...</p>
      </div>
    );
  }

  if (step === "success") {
    const refund = result?.refundAmountCents || 0;
    const isCredit = result?.refundMethod === "credit";
    // Issue #1705: when the admin chose "Cancel without emailing", the standard
    // email-promise copy would be untrue — state the recorded choice instead.
    const emailSuppressed = notifiedMember === false;
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-4 space-y-1">
        <p className="text-sm font-medium text-green-800">
          {onBehalfOfMember
            ? "Booking cancelled on behalf of the member"
            : "Booking cancelled successfully"}
        </p>
        {result?.creditRestoredCents && result.creditRestoredCents > 0 && (
          <p className="text-sm text-green-700">
            {formatDollars(result.creditRestoredCents)} of previously applied credit has been returned to {onBehalfOfMember ? "the member's" : "your"} account.
          </p>
        )}
        {refund > 0 && isCredit ? (
          <p className="text-sm text-green-700">
            A credit of {formatDollars(refund)} has been added to {onBehalfOfMember ? "the member's" : "your"} account for future bookings.
          </p>
        ) : refund > 0 ? (
          <p className="text-sm text-green-700">
            {onBehalfOfMember
              ? `The refund of ${formatDollars(refund)} has been processed to the member's original payment method.${emailSuppressed ? "" : " They will receive a confirmation email shortly."}`
              : `Your refund of ${formatDollars(refund)} has been processed to your original payment method.${emailSuppressed ? "" : " You will receive a confirmation email shortly."}`}
          </p>
        ) : emailSuppressed ? null : (
          <p className="text-sm text-green-700">
            {onBehalfOfMember
              ? "The member will receive a confirmation email shortly."
              : "You will receive a confirmation email shortly."}
          </p>
        )}
        {emailSuppressed && (
          <p className="text-sm text-green-700">
            The member was not emailed about this cancellation — your choice is
            recorded in the audit log.
          </p>
        )}
      </div>
    );
  }

  if (step === "error") {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 space-y-2">
        <p className="text-sm text-red-700">{errorMsg}</p>
        <Button variant="outline" size="sm" onClick={() => setStep("idle")}>
          Try Again
        </Button>
      </div>
    );
  }

  // Preview step
  if (step === "preview" && preview) {
    // A credit-only booking can have card slices at 0 but still restore a
    // positive (tiered) applied-credit amount (#1164): treat that as a
    // refund-bearing cancel so the restored-credit row is not hidden behind
    // "No refund applies".
    const hasCardRefund =
      preview.refundAmountCents > 0 || preview.creditRefundAmountCents > 0;
    const hasRefund = hasCardRefund || preview.creditRestoredCents > 0;

    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 space-y-3">
        <p className="text-sm font-medium text-red-800">
          {onBehalfOfMember
            ? "Cancel on behalf of member"
            : "Cancellation Summary"}
        </p>

        {onBehalfOfMember && (
          <p className="text-sm text-red-700">
            You are cancelling this booking on behalf of the member. Any refund
            or account credit is applied to the member&apos;s account
            {canChooseMemberEmail
              ? " — you will choose whether the member is emailed when you confirm."
              : " and they are notified by email."}
          </p>
        )}

        {!preview.hasPayment ? (
          <div className="space-y-1">
            <p className="text-sm text-slate-700">
              No payment has been taken for this booking. No refund applies.
            </p>
            {preview.creditRestoredCents > 0 && (
              <p className="text-sm text-green-700">
                {formatDollars(preview.creditRestoredCents)} of previously applied
                account credit will be returned to{" "}
                {onBehalfOfMember ? "the member's" : "your"} account.
              </p>
            )}
          </div>
        ) : !hasRefund ? (
          <p className="text-sm text-slate-700">
            No refund applies per cancellation policy.
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            {/* Refund method selection — only meaningful when a card/bank slice
                can be refunded. A credit-only cancel (#1164) has no card slice,
                so the radios are hidden and only the restored-credit row shows. */}
            {hasCardRefund && (
              <div className="space-y-2">
                <p className="font-medium text-slate-700">Choose refund method:</p>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="refundMethod"
                    value="card"
                    checked={refundMethod === "card"}
                    onChange={() => setRefundMethod("card")}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-slate-800">
                      Refund {formatDollars(preview.refundAmountCents)} to original payment method
                    </span>
                    <span className="text-slate-500 ml-1">({preview.refundPercentage}% refund)</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="refundMethod"
                    value="credit"
                    checked={refundMethod === "credit"}
                    onChange={() => setRefundMethod("credit")}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-green-700">
                      Hold {formatDollars(preview.creditRefundAmountCents)} as account credit
                    </span>
                    <span className="text-slate-500 ml-1">({preview.creditRefundPercentage}% refund)</span>
                    {preview.creditRefundAmountCents > preview.refundAmountCents && (
                      <span className="ml-1 text-xs text-green-600 font-medium">
                        +{formatDollars(preview.creditRefundAmountCents - preview.refundAmountCents)} more
                      </span>
                    )}
                  </span>
                </label>
              </div>
            )}

            {/* Amount summary */}
            <div className="border-t border-red-100 pt-2 space-y-1">
              {hasCardRefund && (
                <div className="flex justify-between">
                  <span className="text-slate-600">
                    {refundMethod === "credit" ? "Credit to account:" : "Refund to card:"}
                  </span>
                  <span className="font-medium text-green-700">
                    {formatDollars(
                      refundMethod === "credit"
                        ? preview.creditRefundAmountCents
                        : preview.refundAmountCents
                    )}
                  </span>
                </div>
              )}
              {preview.keptAmountCents > 0 && refundMethod === "card" && (
                <div className="flex justify-between">
                  <span className="text-slate-600">
                    Amount kept ({preview.refundPercentage}% refund):
                  </span>
                  <span className="font-medium text-slate-700">{formatDollars(preview.keptAmountCents)}</span>
                </div>
              )}
              {refundAppealDescription ? (
                <p className="pt-2 text-xs text-slate-500">
                  {refundAppealDescription}
                </p>
              ) : null}
              {preview.changeFeeCents > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Change fees (non-refundable):</span>
                  <span className="font-medium text-slate-700">{formatDollars(preview.changeFeeCents)}</span>
                </div>
              )}
              {preview.creditRestoredCents > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-600">
                    Previously applied credit restored (per the cancellation policy):
                  </span>
                  <span className="font-medium text-green-700">{formatDollars(preview.creditRestoredCents)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleConfirmCancel}
          >
            Confirm Cancellation
          </Button>
          <Button variant="outline" size="sm" onClick={() => setStep("idle")}>
            Keep Booking
          </Button>
        </div>

        {/* Owner decision (#1705, extending #1668/#1696): the admin explicitly
            chooses, per cancellation, whether the member is emailed. Both
            choices cancel the booking; the choice itself is recorded in the
            audit log. */}
        <Dialog open={notifyDialogOpen} onOpenChange={setNotifyDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Email the member about this cancellation?</DialogTitle>
              <DialogDescription>
                The booking will be cancelled either way, and any refund or
                account credit is applied regardless. Choose whether the member
                receives the standard cancellation email — your choice is
                recorded in the audit log.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setNotifyDialogOpen(false);
                  void performCancel(false);
                }}
              >
                Cancel without emailing
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setNotifyDialogOpen(false);
                  void performCancel(true);
                }}
              >
                Cancel and email member
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // Cancelling state
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm text-slate-500">Cancelling booking...</p>
    </div>
  );
}
