"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type DeleteBookingMode = "draft" | "cancelled";

type DeleteBookingResponse = {
  error?: string;
  blockers?: Array<{ code: string; label: string; count: number }>;
};

export function DeleteBookingButton({
  bookingId,
  mode,
  returnHref,
}: {
  bookingId: string;
  mode: DeleteBookingMode;
  returnHref: string;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<
    Array<{ code: string; label: string; count: number }>
  >([]);
  const [deleting, setDeleting] = useState(false);
  const requiresReason = mode === "cancelled";

  async function handleDelete() {
    setError(null);
    setBlockers([]);

    if (requiresReason && reason.trim().length < 3) {
      setError("Enter a deletion reason.");
      return;
    }

    if (
      mode === "draft" &&
      !window.confirm("Delete this draft booking?")
    ) {
      return;
    }

    setDeleting(true);
    try {
      const response = await fetch(`/api/bookings/${bookingId}`, {
        method: "DELETE",
        headers: requiresReason ? { "Content-Type": "application/json" } : undefined,
        body: requiresReason ? JSON.stringify({ reason }) : undefined,
      });
      const body = (await response.json().catch(() => ({}))) as DeleteBookingResponse;

      if (!response.ok) {
        setError(body.error ?? "Failed to delete booking");
        setBlockers(body.blockers ?? []);
        return;
      }

      router.push(returnHref);
      router.refresh();
    } catch {
      setError("Failed to delete booking");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-red-200 bg-red-50 p-4">
      {requiresReason ? (
        <div className="space-y-1">
          <label
            htmlFor="delete-booking-reason"
            className="text-sm font-medium text-red-950"
          >
            Deletion reason
          </label>
          <textarea
            id="delete-booking-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-20 w-full rounded-md border border-red-200 bg-white px-3 py-2 text-sm shadow-sm"
            maxLength={500}
          />
        </div>
      ) : null}

      {error ? <p className="text-sm text-red-800">{error}</p> : null}
      {blockers.length > 0 ? (
        <ul className="space-y-1 text-sm text-red-800">
          {blockers.map((blocker) => (
            <li key={blocker.code}>
              {blocker.label} ({blocker.count})
            </li>
          ))}
        </ul>
      ) : null}

      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={handleDelete}
        disabled={deleting || (requiresReason && reason.trim().length < 3)}
      >
        <Trash2 className="mr-2 h-4 w-4" />
        {deleting
          ? "Deleting..."
          : mode === "draft"
            ? "Delete Draft"
            : "Delete Cancelled Booking"}
      </Button>
    </div>
  );
}
