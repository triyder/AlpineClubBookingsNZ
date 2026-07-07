"use client";

import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BOOKING_STATUS_GLOSSARY } from "@/lib/contextual-help";
import type { CancellationScheduleRow } from "@/lib/cancellation-schedule";

/**
 * Member-facing booking help. Surfaces two things that previously only existed
 * behind admin/finance layouts (#1371 F28):
 *  - the booking status glossary (#1072), so members can decode badges like
 *    "Confirmed (Unpaid)" and "Bumped"; and
 *  - the applicable cancellation refund schedule (#1239), when the booking can
 *    still be cancelled AND a payment has been captured, so a member learns the
 *    refund consequences before cancel time — not only inside the cancel dialog.
 *
 * When the booking is cancellable but unpaid, the refund tiers would imply a
 * refund the member cannot receive, so we say "no payment received, no refund"
 * plainly instead (owner review of PR #1389).
 */
export function BookingHelpDialog({
  cancellationSchedule,
  cancellationHasNoPayment = false,
}: {
  cancellationSchedule?: CancellationScheduleRow[];
  cancellationHasNoPayment?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasSchedule = Boolean(cancellationSchedule && cancellationSchedule.length > 0);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="Booking status and cancellation help"
        title="Booking status and cancellation help"
        className="shrink-0 print:hidden"
      >
        <CircleHelp className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Booking help</DialogTitle>
            <DialogDescription>
              {hasSchedule
                ? "What your booking statuses mean, and how much is refunded if you cancel."
                : cancellationHasNoPayment
                  ? "What your booking statuses mean, and what cancelling means for you."
                  : "What your booking statuses mean."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Booking statuses</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
                {BOOKING_STATUS_GLOSSARY.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>

            {hasSchedule ? (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">
                  Cancellation refund schedule
                </h3>
                <p className="text-sm text-muted-foreground">
                  How much is refunded depends on how many days before your stay
                  you cancel:
                </p>
                <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
                  {cancellationSchedule!.map((row) => (
                    <li key={row.description}>{row.description}</li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  The exact amount for your booking is shown when you start a
                  cancellation.
                </p>
              </section>
            ) : cancellationHasNoPayment ? (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Cancelling this booking</h3>
                <p className="text-sm text-muted-foreground">
                  No payment has been received for this booking, so no refund
                  applies if you cancel.
                </p>
              </section>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
