"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { formatNZDate, formatNZDateTime } from "@/lib/nzst-date";
import { formatCents } from "@/lib/utils";

type ReviewFilter = "PENDING" | "APPROVED" | "REJECTED" | "ALL";

const reviewFilters = new Set<ReviewFilter>(["PENDING", "APPROVED", "REJECTED", "ALL"]);

function isReviewFilter(value: string | null): value is ReviewFilter {
  return reviewFilters.has(value as ReviewFilter);
}

interface BookingReviewData {
  id: string;
  checkIn: string;
  checkOut: string;
  status: string;
  finalPriceCents: number;
  memberReviewJustification: string | null;
  adminReviewStatus: "PENDING" | "APPROVED" | "REJECTED" | null;
  adminReviewNotes: string | null;
  adminReviewedAt: string | null;
  createdAt: string;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  adminReviewedBy: {
    id: string;
    firstName: string;
    lastName: string;
  } | null;
  guests: Array<{
    id: string;
    firstName: string;
    lastName: string;
    ageTier: string;
    isMember: boolean;
  }>;
}

function statusBadgeClass(status: BookingReviewData["adminReviewStatus"]) {
  if (status === "PENDING") return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "APPROVED") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  return "border-border bg-muted text-muted-foreground";
}

interface BookingApprovalsPanelProps {
  basePath?: string;
  fixedSearchParams?: Record<string, string>;
  showHeading?: boolean;
  canEdit?: boolean;
}

const EMPTY_SEARCH_PARAMS: Record<string, string> = {};

function buildBookingApprovalsPath(
  basePath: string,
  fixedSearchParams: Record<string, string>,
  status: ReviewFilter,
  bookingId: string | null,
) {
  const params = new URLSearchParams(fixedSearchParams);

  if (bookingId) {
    params.set("bookingId", bookingId);
  }

  if (status !== "PENDING") {
    params.set("status", status);
  }

  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function BookingApprovalsPanel({
  basePath = "/admin/booking-requests",
  fixedSearchParams = EMPTY_SEARCH_PARAMS,
  showHeading = true,
  canEdit = true,
}: BookingApprovalsPanelProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialFilter = searchParams.get("status");
  const focusedBookingId = searchParams.get("bookingId");
  const [bookings, setBookings] = useState<BookingReviewData[]>([]);
  const [filter, setFilter] = useState<ReviewFilter>(
    isReviewFilter(initialFilter) ? initialFilter : "PENDING",
  );
  const [loading, setLoading] = useState(true);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  // #1790: which decision is waiting on the admin's notify-or-not choice, and
  // whether the dialog is open. Both approve and reject always email the member
  // (unconditional sends in the route), so the dialog is shown for both. The
  // choice is kept set while the dialog fades out (Radix keeps the content
  // mounted through its exit animation) so the copy never flickers to the other
  // decision's wording.
  const [notifyChoice, setNotifyChoice] = useState<
    { bookingId: string; decision: "APPROVED" | "REJECTED" } | null
  >(null);
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);
  const currentPath = buildBookingApprovalsPath(
    basePath,
    fixedSearchParams,
    filter,
    focusedBookingId,
  );

  const fetchBookings = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/booking-reviews?status=${filter}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to load booking reviews");
      }
      setBookings(Array.isArray(data?.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load booking reviews");
    } finally {
      setLoading(false);
    }
    // setState functions are referentially stable; they are listed so the
    // manual dependencies match what the React Compiler infers.
  }, [filter, setBookings, setError, setLoading]);

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings]);

  useEffect(() => {
    router.replace(currentPath, { scroll: false });
  }, [currentPath, router]);

  // #1790: validate the decision (reject needs admin notes) and then open the
  // notify-choice dialog. Both decisions email the member either way, so the
  // dialog always asks; the actual PATCH runs from confirmNotify.
  function requestDecision(bookingId: string, decision: "APPROVED" | "REJECTED") {
    const adminNotes = notesById[bookingId]?.trim() ?? "";
    if (decision === "REJECTED" && !adminNotes) {
      setError("Please add admin notes before rejecting so the member gets a reason.");
      return;
    }
    setError("");
    setNotifyChoice({ bookingId, decision });
    setNotifyDialogOpen(true);
  }

  // #1790: dispatch the pending decision with the admin's notify choice. Close
  // the dialog without clearing the choice, so the content keeps its wording
  // while it fades out.
  function confirmNotify(notify: boolean) {
    const choice = notifyChoice;
    setNotifyDialogOpen(false);
    if (!choice) return;
    void performDecision(choice.bookingId, choice.decision, notify);
  }

  async function performDecision(
    bookingId: string,
    decision: "APPROVED" | "REJECTED",
    notifyMember: boolean,
  ) {
    const adminNotes = notesById[bookingId]?.trim() ?? "";
    setReviewingId(bookingId);
    setError("");
    try {
      const response = await fetch(`/api/admin/bookings/${bookingId}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: decision, adminNotes, notifyMember }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to record decision");
      }
      setNotesById((prev) => {
        const next = { ...prev };
        delete next[bookingId];
        return next;
      });
      // #1790 honesty: approve sends only the review-approved email, so
      // suppressing it means no email at all. Reject also triggers the shared
      // cancellation flow, whose cancellation notice is deliberately
      // always-notify (#1730, DOMAIN_INVARIANTS), so a suppressed reject only
      // withholds the review-declined explainer — the member is still emailed.
      const suppressedNote =
        notifyMember === false
          ? decision === "APPROVED"
            ? " The member was not emailed."
            : " The review-declined email was not sent."
          : "";
      toast.success(
        (decision === "APPROVED" ? "Booking approved." : "Booking rejected and cancelled.") +
          suppressedNote,
      );
      await fetchBookings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record decision");
    } finally {
      setReviewingId(null);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before
    its content appears; a region injected already-populated is silently dropped
    by some screen-reader/browser pairings. It sits OUTSIDE the `space-y-6`
    stack so the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view bookings awaiting approval but cannot decide
      them. Bookings edit access is required to approve or reject a booking.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      {showHeading ? (
        <div>
          <h1 className="text-3xl font-bold">Booking approvals</h1>
          <p className="mt-1 text-muted-foreground">
            Review bookings that need admin approval before they can be paid.
            See also{" "}
            <Link className="underline" href="/admin/booking-requests?tab=changes">
              booking change requests
            </Link>{" "}
            and{" "}
            <Link className="underline" href="/admin/refund-requests">
              refund requests
            </Link>
            .
          </p>
        </div>
      ) : null}

      {error && (
        <div className="rounded-md bg-destructive/10 px-4 py-3 text-destructive">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}


      <div className="flex flex-wrap gap-2">
        {(["PENDING", "APPROVED", "REJECTED", "ALL"] as const).map((status) => (
          <Button
            key={status}
            variant={filter === status ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(status)}
          >
            {status === "ALL" ? "All" : status.charAt(0) + status.slice(1).toLowerCase()}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="py-8 text-center">Loading...</div>
      ) : bookings.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No {filter === "ALL" ? "" : filter.toLowerCase() + " "}booking reviews found.
        </div>
      ) : (
        <div className="space-y-4">
          {bookings.map((booking) => {
            const decided = booking.adminReviewStatus !== "PENDING";
            const highlighted = booking.id === focusedBookingId;
            return (
              <Card
                key={booking.id}
                className={highlighted ? "border-amber-300" : undefined}
              >
                <CardHeader>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <CardTitle className="text-lg">
                        {booking.member.firstName} {booking.member.lastName}
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        Created {formatNZDateTime(new Date(booking.createdAt))} —{" "}
                        <Link href={`/admin/bookings/${booking.id}`} className="underline">
                          view booking
                        </Link>
                      </p>
                    </div>
                    <Badge variant="outline" className={statusBadgeClass(booking.adminReviewStatus)}>
                      {booking.adminReviewStatus ?? "—"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <span className="text-muted-foreground">Dates:</span>{" "}
                      {formatNZDate(new Date(booking.checkIn))} to{" "}
                      {formatNZDate(new Date(booking.checkOut))}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Status:</span> {booking.status}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Total:</span>{" "}
                      {formatCents(booking.finalPriceCents)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Guests:</span>{" "}
                      {booking.guests.length}
                    </div>
                  </div>

                  <div className="rounded-md border bg-muted p-3 text-sm">
                    <p className="font-medium text-foreground">Guests on this booking</p>
                    <ul className="mt-2 space-y-1 text-muted-foreground">
                      {booking.guests.map((guest) => (
                        <li key={guest.id}>
                          {guest.firstName} {guest.lastName} — {guest.ageTier}
                          {guest.isMember ? " (member)" : ""}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {booking.memberReviewJustification && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
                      <p className="font-medium text-amber-900">
                        Member&apos;s reason for booking without an adult
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-amber-900">
                        {booking.memberReviewJustification}
                      </p>
                    </div>
                  )}

                  {decided ? (
                    <div className="rounded-md border bg-muted p-3 text-sm">
                      <p className="font-medium text-foreground">
                        Decision: {booking.adminReviewStatus}
                        {booking.adminReviewedBy
                          ? ` by ${booking.adminReviewedBy.firstName} ${booking.adminReviewedBy.lastName}`
                          : ""}
                        {booking.adminReviewedAt
                          ? ` on ${formatNZDateTime(new Date(booking.adminReviewedAt))}`
                          : ""}
                      </p>
                      {booking.adminReviewNotes && (
                        <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                          {booking.adminReviewNotes}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <label className="text-sm font-medium" htmlFor={`notes-${booking.id}`}>
                        Admin notes (required to reject; optional for approval)
                      </label>
                      <Textarea
                        id={`notes-${booking.id}`}
                        value={notesById[booking.id] ?? ""}
                        disabled={!canEdit}
                        title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
                        onChange={(event) =>
                          setNotesById((prev) => ({ ...prev, [booking.id]: event.target.value }))
                        }
                        rows={3}
                        maxLength={2000}
                        placeholder="Explain your decision. The member will see this note."
                      />
                      <div className="flex flex-wrap gap-2">
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          onClick={() => requestDecision(booking.id, "APPROVED")}
                          disabled={reviewingId === booking.id}
                        >
                          Approve
                        </ViewOnlyActionButton>
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          variant="destructive"
                          onClick={() => requestDecision(booking.id, "REJECTED")}
                          disabled={reviewingId === booking.id}
                        >
                          Reject and cancel
                        </ViewOnlyActionButton>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* #1790: per-decision member-email choice, mirroring the #1695/#1705
          pattern. Both approve and reject email the member either way, so the
          dialog always asks; the choice itself is recorded in the audit log.
          It suppresses only the review approval/rejection notice — the shared
          cancellation flow behind a reject is unaffected. */}
      <Dialog
        open={notifyDialogOpen}
        onOpenChange={(open) => {
          if (!open && reviewingId === null) setNotifyDialogOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {notifyChoice?.decision === "REJECTED"
                ? "Email the member about this decline?"
                : "Email the member about this approval?"}
            </DialogTitle>
            <DialogDescription>
              {notifyChoice?.decision === "REJECTED"
                ? "The booking is declined and cancelled either way, and the member always receives the standard cancellation notice. Choose whether they also receive the review-declined explainer email — your choice is recorded in the audit log."
                : "The booking is approved either way. Choose whether the member receives the standard review-approved email — your choice is recorded in the audit log."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={reviewingId !== null}
              onClick={() => confirmNotify(false)}
            >
              {notifyChoice?.decision === "REJECTED"
                ? "Reject without emailing"
                : "Approve without emailing"}
            </Button>
            <Button
              disabled={reviewingId !== null}
              onClick={() => confirmNotify(true)}
            >
              {notifyChoice?.decision === "REJECTED"
                ? "Reject and email member"
                : "Approve and email member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
