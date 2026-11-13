"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubFormat } from "@/components/club-format-provider";
import { formatCents } from "@/lib/pricing";
import type { WorkPartyCorrectionFigures } from "@/lib/work-party-booking-correction";

type WorkPartyOption = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  discountPercent: number;
  lodgeName: string | null;
  eligible: boolean;
  reason: string | null;
};

/**
 * "Add booking to work party" (fork #119), on the admin tools card of a
 * booking. For a member who forgot to tick "I am attending a working bee": the
 * officer picks the work party, sees what the booking will cost and how much
 * comes back as account credit (a dry run of the real change), and confirms.
 * The figures shown are the figures saved — the route refuses if they moved.
 * Bookings edit; a bookings-view admin sees the button disabled.
 */
export function BookingWorkPartyControls({
  bookingId,
  noEmails = false,
}: {
  bookingId: string;
  /** The booking's "No emails" switch: when on, the member is not emailed. */
  noEmails?: boolean;
}) {
  const canEdit = useAdminAreaEditAccess("bookings");
  const format = useClubFormat();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<WorkPartyOption[] | null>(null);
  const [current, setCurrent] = useState<{ name: string } | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [figures, setFigures] = useState<WorkPartyCorrectionFigures | null>(null);
  const [notifyMember, setNotifyMember] = useState(!noEmails);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const money = (cents: number) => formatCents(cents, format);

  async function openDialog() {
    setOpen(true);
    setError("");
    setFigures(null);
    setOptions(null);
    setCurrent(null);
    setSelectedId("");
    setNotifyMember(!noEmails);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}/work-party`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not load the work parties for this booking.");
        return;
      }
      setOptions(data.workParties ?? []);
      setCurrent(data.currentWorkParty ?? null);
      const firstEligible = (data.workParties ?? []).find((o: WorkPartyOption) => o.eligible);
      setSelectedId(firstEligible?.id ?? "");
    } catch {
      setError("Could not load the work parties for this booking. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function send(mode: "preview" | "apply") {
    if (!selectedId) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}/work-party`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "preview"
            ? { mode, workPartyEventId: selectedId }
            : { mode, workPartyEventId: selectedId, notifyMember, expectedFigures: figures },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === "FIGURES_CHANGED") {
        setFigures(data.figures);
        setError(data.error);
        return;
      }
      if (!res.ok) {
        setError(data.error || "The booking could not be added to the work party.");
        return;
      }
      if (mode === "preview") {
        setFigures(data.figures);
        return;
      }
      setOpen(false);
      toast.success("Booking added to the work party.");
      if (data.followUpFailed) {
        toast.warning(
          "Saved, but a follow-up step (email or accounting) did not complete. Check the booking.",
        );
      }
      router.refresh();
    } catch {
      setError("The request did not reach the server. Nothing was changed; try again.");
    } finally {
      setBusy(false);
    }
  }

  const selected = options?.find((o) => o.id === selectedId) ?? null;

  return (
    <div className="space-y-1">
      <ViewOnlyActionButton
        canEdit={canEdit}
        variant="outline"
        size="sm"
        onClick={openDialog}
      >
        Add to work party
      </ViewOnlyActionButton>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add booking to a work party</DialogTitle>
            <DialogDescription>
              For a member who forgot to tick &ldquo;I am attending a working
              bee&rdquo;. The booking is repriced with the work party&apos;s
              discount, and anything already paid above the new total goes back
              as account credit.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {loading && <p className="text-muted-foreground">Loading…</p>}
            {current && (
              <p>This booking is already on &ldquo;{current.name}&rdquo;.</p>
            )}
            {!loading && !current && options && options.length === 0 && (
              <p className="text-muted-foreground">
                No active work party overlaps this booking&apos;s nights.
              </p>
            )}
            {!loading && !current && options && options.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor={`work-party-${bookingId}`}>Work party</Label>
                <Select
                  value={selectedId}
                  onValueChange={(value) => {
                    setSelectedId(value);
                    setFigures(null);
                    setError("");
                  }}
                >
                  <SelectTrigger
                    id={`work-party-${bookingId}`}
                    className="w-full"
                    aria-describedby={`work-party-reasons-${bookingId}`}
                  >
                    <SelectValue placeholder="Choose a work party…" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((o) => (
                      <SelectItem key={o.id} value={o.id} disabled={!o.eligible}>
                        {o.name} ({o.startDate} – {o.endDate}, {o.discountPercent}% off)
                        {o.lodgeName ? ` — ${o.lodgeName}` : ""}
                        {o.eligible ? "" : " — not available"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div id={`work-party-reasons-${bookingId}`}>
                  {options
                    .filter((o) => !o.eligible && o.reason)
                    .map((o) => (
                      <p key={o.id} className="text-xs text-muted-foreground">
                        {o.name}: {o.reason}
                      </p>
                    ))}
                </div>
              </div>
            )}
            {figures && selected && (
              <div
                className="space-y-1 rounded-md border p-3"
                data-testid="work-party-figures"
                aria-live="polite"
              >
                <p>
                  New total: <strong>{money(figures.newFinalPriceCents)}</strong>{" "}
                  (was {money(figures.previousFinalPriceCents)})
                </p>
                <p>
                  Account credit to the member:{" "}
                  <strong>
                    {money(figures.accountCreditAmountCents + figures.appliedCreditGivenBackCents)}
                  </strong>
                </p>
                {figures.additionalAmountCents > 0 && (
                  <p>
                    Still to pay: <strong>{money(figures.additionalAmountCents)}</strong>
                  </p>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <Checkbox
                    id={`work-party-notify-${bookingId}`}
                    checked={notifyMember}
                    onCheckedChange={(checked) => setNotifyMember(checked === true)}
                  />
                  <Label htmlFor={`work-party-notify-${bookingId}`}>
                    Email the member about the change
                  </Label>
                  {noEmails && (
                    <span className="text-xs text-muted-foreground">
                      (this booking has No emails on)
                    </span>
                  )}
                </div>
              </div>
            )}
            {error && (
              <p role="alert" className="font-medium text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            {figures ? (
              <Button onClick={() => send("apply")} disabled={busy || !selectedId}>
                {busy ? "Saving…" : "Add to work party"}
              </Button>
            ) : (
              <Button
                onClick={() => send("preview")}
                disabled={busy || !selectedId || Boolean(current)}
              >
                {busy ? "Checking…" : "Show the new total"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
