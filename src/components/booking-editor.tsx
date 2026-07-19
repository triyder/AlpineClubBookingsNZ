"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EditBookingPanel } from "@/components/edit-booking-panel";
import { formatCents } from "@/lib/utils";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { formatNZDate } from "@/lib/nzst-date";

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  memberId?: string | null;
  stayStart?: string | null;
  stayEnd?: string | null;
  nights?: string[] | null;
  priceCents: number;
}

interface PromoInfo {
  code: string;
  type: string;
  description: string | null;
  // Set when this discount came from a work party (working bee) event's
  // internal promo rather than a manually entered code.
  workPartyEventName?: string | null;
}

interface EditPolicyInfo {
  mode: "future" | "in-progress" | null;
  today: string;
  editableFrom: string | null;
  checkInEditable: boolean;
  // Issue #1668: an admin may override the date-window locks for this booking.
  // Optional so pre-existing fixtures/serialisers stay valid; the booking page
  // always sets it.
  adminOverrideAvailable?: boolean;
}

export interface BookingEditorData {
  id: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  status: string;
  guests: Guest[];
  viewerRole: string;
  totalPriceCents: number;
  discountCents: number;
  promoAdjustmentCents: number;
  finalPriceCents: number;
  promo: PromoInfo | null;
  hasNonMembers: boolean;
  nonMemberHoldUntil: string | null;
  canEditNonMemberGuestNames: boolean;
  canFixNonMemberGuestNameTypos: boolean;
  editPolicy: EditPolicyInfo;
  // #2104: threaded so the edit panel can skip the proactive justification field
  // for a booking that is already flagged/reviewed (the server only demands a
  // reason on the FIRST no-adult trip).
  requiresAdminReview: boolean;
  adminReviewStatus: string | null;
}


export function BookingEditor({
  booking,
  canModify,
  canAdminOverride = false,
}: {
  booking: BookingEditorData;
  canModify: boolean;
  // Issue #1668: admin override lets an admin open the editor even for a
  // fully-past booking that renders no self-service editor at all.
  canAdminOverride?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const canOpenEditor = canModify || canAdminOverride;
  // Capture "now" once at mount so the hold banner can honestly tell a future
  // deadline (future-tense auto-confirm copy) from a lapsed one (awaiting
  // processing copy). Day-scale deadlines make a single snapshot sufficient.
  const [nowMs] = useState(() => Date.now());
  const nonMemberHoldLapsed = booking.nonMemberHoldUntil
    ? new Date(booking.nonMemberHoldUntil).getTime() <= nowMs
    : false;

  if (editing && canOpenEditor) {
    return (
      <EditBookingPanel
        booking={{
          id: booking.id,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guests: booking.guests,
          viewerRole: booking.viewerRole,
          finalPriceCents: booking.finalPriceCents,
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          promo: booking.promo,
          canEditNonMemberGuestNames: booking.canEditNonMemberGuestNames,
          canFixNonMemberGuestNameTypos: booking.canFixNonMemberGuestNameTypos,
          editPolicy: booking.editPolicy,
          requiresAdminReview: booking.requiresAdminReview,
          adminReviewStatus: booking.adminReviewStatus,
        }}
        canAdminOverride={canAdminOverride}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Stay Details */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CardTitle>Stay Details</CardTitle>
              {canOpenEditor && (
                <Button variant="outline" onClick={() => setEditing(true)}>
                  Edit Booking
                </Button>
              )}
            </div>
            <Badge variant="secondary" className={bookingStatusClass(booking.status)}>
              {bookingStatusLabel(booking.status)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-gray-500">Check-in</p>
              <p className="font-medium">
                {new Date(booking.checkIn + "T00:00:00").toLocaleDateString("en-NZ", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Check-out</p>
              <p className="font-medium">
                {new Date(booking.checkOut + "T00:00:00").toLocaleDateString("en-NZ", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Nights</p>
              <p className="font-medium">{booking.nights}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Guests</p>
              <p className="font-medium">{booking.guests.length}</p>
            </div>
          </div>

          {booking.status === "PENDING" && booking.nonMemberHoldUntil && (
            <div className="rounded-md bg-yellow-50 p-3 text-sm text-yellow-800">
              {nonMemberHoldLapsed ? (
                <>
                  This booking includes non-members. The hold period ended on{" "}
                  {formatNZDate(new Date(booking.nonMemberHoldUntil))} and it is now
                  awaiting confirmation, payment, or admin processing, subject to
                  availability. Members have priority.
                </>
              ) : (
                <>
                  This booking includes non-members. It will be auto-confirmed on{" "}
                  {formatNZDate(new Date(booking.nonMemberHoldUntil))}, subject to
                  availability. Members have priority.
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Guests */}
      <Card>
        <CardHeader>
          <CardTitle>Guests</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {booking.guests.map((guest) => (
              <div key={guest.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium">
                    {guest.firstName} {guest.lastName}
                  </p>
                  <p className="text-sm text-gray-500">
                    {guest.ageTier} &middot; {guest.isMember ? "Member" : "Non-member"}
                  </p>
                  {(guest.stayStart && guest.stayStart !== booking.checkIn) ||
                  (guest.stayEnd && guest.stayEnd !== booking.checkOut) ? (
                    <p className="text-xs text-gray-500">
                      Stay: {guest.stayStart ?? booking.checkIn} to{" "}
                      {guest.stayEnd ?? booking.checkOut}
                    </p>
                  ) : null}
                </div>
                <p className="font-medium">{formatCents(guest.priceCents)}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Payment */}
      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatCents(booking.totalPriceCents)}</span>
          </div>
          {booking.promoAdjustmentCents !== 0 && (
            <div className={`flex justify-between ${booking.promoAdjustmentCents > 0 ? "text-orange-700" : "text-green-600"}`}>
              <span>
                {booking.promo?.workPartyEventName
                  ? "Working bee discount"
                  : "Promo adjustment"}
                {booking.promo?.workPartyEventName ? (
                  <span className="ml-1 text-xs">
                    ({booking.promo.workPartyEventName})
                  </span>
                ) : (
                  booking.promo?.code && (
                    <span className="ml-1 text-xs">({booking.promo.code})</span>
                  )
                )}
              </span>
              <span>
                {booking.promoAdjustmentCents > 0 ? "+" : "-"}
                {formatCents(Math.abs(booking.promoAdjustmentCents))}
              </span>
            </div>
          )}
          <div className="flex justify-between border-t pt-2 font-bold">
            <span>Total</span>
            <span>{formatCents(booking.finalPriceCents)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
