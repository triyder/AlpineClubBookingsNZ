"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/confirm-dialog";

/** Admin-only summary of a booking that overlaps this hold (issue #119). */
export interface ExclusiveHoldConflict {
  id: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: string;
  /**
   * True when this overlap is NOT capacity-holding yet but carries a persisted
   * capacity override (ADR-001 decision 1, issue #177): the settlement carve-out
   * (#1771) will later admit it onto the held nights. Rendered with an
   * "overridden, not yet holding" marker so the officer is warned up front.
   */
  overridden?: boolean;
}

interface AdminExclusiveHoldControlsProps {
  bookingId: string;
  /** Whether the exclusive whole-lodge hold is currently set (#121). */
  wholeLodgeHold: boolean;
  /** ISO timestamp of the hold, for display. */
  wholeLodgeHoldAt: string | null;
  /** Name of the admin who set the hold, when known. */
  heldByName: string | null;
  /**
   * Whether this booking holds lodge capacity (bookingHoldsCapacity semantics,
   * issue #173). Setting an exclusive hold is only meaningful on a
   * capacity-holding booking — the enforcement/masking indexes are built from
   * the capacity-holding population (ADR-001 capacity rule), so a hold on a
   * non-holding booking blocks nothing. The Set control is disabled with a hint
   * when this is false, mirroring how AdminCapacityHoldControls scopes to
   * PAYMENT_PENDING. Clearing an existing hold is always allowed.
   */
  holdsCapacity: boolean;
  /**
   * Existing capacity-holding bookings that overlap this hold's nights
   * (ADR-001 decision 1, issue #119). Admin-only; surfaced so the officer can
   * resolve the clash manually. Server-computed for the current hold state.
   */
  conflicts?: ExclusiveHoldConflict[];
}

/**
 * Exclusive whole-lodge hold set/clear control for the Admin tools card
 * (issue #121, ADR-001). Reflects Booking.wholeLodgeHold and POSTs the new
 * state to /api/admin/bookings/[id]/exclusive-hold. Setting the hold has NO
 * empty-lodge precondition (decision 1) — it is allowed over existing
 * overlapping bookings, which the officer resolves manually.
 */
export function AdminExclusiveHoldControls({
  bookingId,
  wholeLodgeHold,
  wholeLodgeHoldAt,
  heldByName,
  holdsCapacity,
  conflicts = [],
}: AdminExclusiveHoldControlsProps) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function callRoute(hold: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/bookings/${bookingId}/exclusive-hold`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hold }),
        },
      );
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          conflicts?: ExclusiveHoldConflict[];
        };
        // Conflict surfacing (issue #119): the set succeeded (decision 1); warn
        // if existing bookings overlap so the officer resolves them manually.
        if (hold && data.conflicts && data.conflicts.length > 0) {
          toast.warning(
            `Exclusive hold set. ${data.conflicts.length} existing booking${
              data.conflicts.length === 1 ? "" : "s"
            } overlap these nights — resolve manually.`,
          );
        } else {
          toast.success(
            hold
              ? "Exclusive whole-lodge hold set."
              : "Exclusive whole-lodge hold cleared.",
          );
        }
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      const message =
        data.error ||
        (hold
          ? "Failed to set the exclusive hold"
          : "Failed to clear the exclusive hold");
      setError(message);
      toast.error(message);
    } catch {
      const message = hold
        ? "Failed to set the exclusive hold"
        : "Failed to clear the exclusive hold";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSet() {
    const confirmed = await confirm({
      title: "Set the exclusive whole-lodge hold?",
      description:
        "The whole lodge is reserved for this booking's group — no other beds can be booked on its nights, even if beds are free. Any existing overlapping bookings are not changed; resolve them manually.",
      confirmLabel: "Set hold",
    });
    if (!confirmed) return;
    await callRoute(true);
  }

  async function handleClear() {
    const confirmed = await confirm({
      title: "Clear the exclusive whole-lodge hold?",
      description:
        "Other members can book the remaining beds on these nights again. The booking itself is unchanged.",
      confirmLabel: "Clear hold",
    });
    if (!confirmed) return;
    await callRoute(false);
  }

  return (
    <div className="space-y-2">
      {confirmDialog}
      {wholeLodgeHold && (
        <div className="rounded-md border border-purple-300 bg-purple-50 px-3 py-2 text-sm text-purple-900">
          <p className="font-medium">Exclusive whole-lodge hold</p>
          <p>
            The whole lodge is reserved for this group
            {heldByName ? ` by ${heldByName}` : ""}
            {wholeLodgeHoldAt
              ? ` since ${new Date(wholeLodgeHoldAt).toLocaleDateString("en-NZ")}`
              : ""}
            . New admissions are blocked on these nights.
          </p>
        </div>
      )}
      {wholeLodgeHold && conflicts.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-medium">
            {conflicts.length} overlapping booking
            {conflicts.length === 1 ? "" : "s"} to resolve
          </p>
          <p>
            These existing bookings overlap the held nights. The hold does not
            change or cancel them — resolve each one manually.
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {conflicts.map((conflict) => (
              <li key={conflict.id}>
                <a href={`/bookings/${conflict.id}`} className="underline">
                  {conflict.memberName}
                </a>{" "}
                · {conflict.checkIn} → {conflict.checkOut} ·{" "}
                {conflict.guestCount} guest
                {conflict.guestCount === 1 ? "" : "s"} · {conflict.status}
                {conflict.overridden && (
                  // #177: an overridden-but-not-yet-holding overlap. It does not
                  // block/refuse the hold, but the settlement carve-out (#1771)
                  // will admit it onto the held nights later — flag it so the
                  // officer resolves it before it settles.
                  <span className="ml-1 rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                    overridden, not yet holding
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {wholeLodgeHold ? (
        // Clearing is always allowed, regardless of status — a stale hold must
        // never be un-clearable (issue #173).
        <Button variant="outline" onClick={handleClear} disabled={busy}>
          {busy ? "Clearing..." : "Clear exclusive hold"}
        </Button>
      ) : holdsCapacity ? (
        <Button variant="outline" onClick={handleSet} disabled={busy}>
          {busy ? "Setting..." : "Set exclusive hold"}
        </Button>
      ) : (
        // Non-capacity-holding booking (issue #173): setting a hold here would
        // block nothing (ADR-001 capacity rule — enforcement reads only the
        // capacity-holding population), so the control is disabled with a hint
        // pointing at the admin capacity hold, mirroring how
        // AdminCapacityHoldControls scopes its own action.
        <div className="space-y-1">
          <Button variant="outline" onClick={handleSet} disabled>
            Set exclusive hold
          </Button>
          <p className="text-sm text-slate-600">
            This booking does not hold lodge capacity, so an exclusive hold
            would block nothing. Apply an admin capacity hold first, then set the
            exclusive hold.
          </p>
        </div>
      )}
    </div>
  );
}
