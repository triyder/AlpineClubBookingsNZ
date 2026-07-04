"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
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
  return "border-slate-200 bg-slate-100 text-slate-700";
}

interface BookingApprovalsPanelProps {
  basePath?: string;
  fixedSearchParams?: Record<string, string>;
  showHeading?: boolean;
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

  async function decideReview(bookingId: string, decision: "APPROVED" | "REJECTED") {
    const adminNotes = notesById[bookingId]?.trim() ?? "";
    if (decision === "REJECTED" && !adminNotes) {
      setError("Please add admin notes before rejecting so the member gets a reason.");
      return;
    }
    setReviewingId(bookingId);
    setError("");
    try {
      const response = await fetch(`/api/admin/bookings/${bookingId}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: decision, adminNotes }),
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
      toast.success(decision === "APPROVED" ? "Booking approved." : "Booking rejected and cancelled.");
      await fetchBookings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record decision");
    } finally {
      setReviewingId(null);
    }
  }

  return (
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

                  <div className="rounded-md border bg-slate-50 p-3 text-sm">
                    <p className="font-medium text-slate-900">Guests on this booking</p>
                    <ul className="mt-2 space-y-1 text-slate-700">
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
                    <div className="rounded-md border bg-slate-50 p-3 text-sm">
                      <p className="font-medium text-slate-900">
                        Decision: {booking.adminReviewStatus}
                        {booking.adminReviewedBy
                          ? ` by ${booking.adminReviewedBy.firstName} ${booking.adminReviewedBy.lastName}`
                          : ""}
                        {booking.adminReviewedAt
                          ? ` on ${formatNZDateTime(new Date(booking.adminReviewedAt))}`
                          : ""}
                      </p>
                      {booking.adminReviewNotes && (
                        <p className="mt-2 whitespace-pre-wrap text-slate-700">
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
                        onChange={(event) =>
                          setNotesById((prev) => ({ ...prev, [booking.id]: event.target.value }))
                        }
                        rows={3}
                        maxLength={2000}
                        placeholder="Explain your decision. The member will see this note."
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          onClick={() => decideReview(booking.id, "APPROVED")}
                          disabled={reviewingId === booking.id}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={() => decideReview(booking.id, "REJECTED")}
                          disabled={reviewingId === booking.id}
                        >
                          Reject and cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
