"use client";

import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";
import { FinishedStayUnlinkedNote } from "@/components/admin/booking-requests/booking-change-request-finished-stay";
import type { BookingChangeRequestData } from "@/components/admin/booking-requests/booking-change-request-panel-model";

/**
 * A decided locked-period change request's card body: who decided it and when,
 * the two notes kept apart (#2562), and what it is linked to. Moved out of
 * `booking-change-requests-panel.tsx` (#4030) so the panel keeps the decision
 * flow within its size budget; the markup is unchanged.
 */
export function DecidedChangeRequestSummary({
  request,
  reviewedAt,
  format,
}: {
  request: BookingChangeRequestData;
  reviewedAt: string | null;
  format: ClubFormat;
}) {
  return (
    <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
      {request.status === "APPROVED" ? "Approved" : "Rejected"}
      {reviewedAt ? ` on ${reviewedAt}` : ""}
      {request.reviewedBy
        ? ` by ${request.reviewedBy.firstName} ${request.reviewedBy.lastName}`
        : ""}
      {/* #2562: after the decision the two notes stay visually
          separated and labelled, so an officer reading a
          colleague's decision knows which half the member has
          already read. */}
      {request.adminNotes ? (
        <div className="mt-2 rounded-md border border-border bg-background p-2">
          <p className="text-xs font-semibold text-foreground">
            Explanation the member can see
          </p>
          <p className="mt-1 whitespace-pre-wrap">
            {request.adminNotes}
          </p>
        </div>
      ) : null}
      {request.internalNotes ? (
        <div className="mt-2 rounded-md border border-dashed border-border bg-background p-2">
          <p className="text-xs font-semibold text-foreground">
            Internal note — admins only, never shown to the member
          </p>
          <p className="mt-1 whitespace-pre-wrap">
            {request.internalNotes}
          </p>
        </div>
      ) : null}
      {request.linkedModification ? (
        <p className="mt-2 text-muted-foreground">
          Linked booking modification:{" "}
          <span className="font-mono">
            {request.linkedModification.id}
          </span>{" "}
          ({request.linkedModification.modificationType},{" "}
          {formatCents(request.linkedModification.priceDiffCents, format)}{" "}
          delta)
        </p>
      ) : request.status === "APPROVED" &&
        request.executesOnApproval ? (
        // #3750: never point at the booking page for a finished stay.
        <FinishedStayUnlinkedNote />
      ) : request.status === "APPROVED" ? (
        <p className="mt-2 text-warning-11">
          No booking modification linked. The booking edit may
          still be outstanding — apply it from the booking page
          (using the admin override control for locked or
          fully-past dates); a date-only request links back here
          automatically when the applied dates match.
        </p>
      ) : null}
    </div>
  );
}
