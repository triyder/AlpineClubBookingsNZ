import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminCapacityHoldControls } from "@/components/admin/admin-capacity-hold-controls";
import {
  AdminExclusiveHoldControls,
  type ExclusiveHoldConflict,
} from "@/components/admin/admin-exclusive-hold-controls";
import { ConfirmPendingGuestsButton } from "@/components/admin/confirm-pending-guests-button";
import { CopyBookingButton } from "@/components/admin/copy-booking-button";
import type { BookingProviderMismatch } from "@/lib/booking-provider-mismatches";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";
import { formatDateOnly } from "@/lib/date-only";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";

/**
 * One visually distinct cluster for everything only admins can do on the
 * member-facing booking detail page: the admin actions plus deep links to the
 * related admin surfaces. Rendered only for admins.
 */
export function AdminBookingToolsCard({
  bookingId,
  memberId,
  memberName,
  checkIn,
  checkOut,
  copyProps,
  isDeleted,
  paymentId,
  showConfirmPendingGuests,
  hasSavedPaymentMethod,
  finalPriceCents,
  providerMismatches = [],
  features,
  capacityHold,
  exclusiveHold,
}: {
  bookingId: string;
  memberId: string;
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  copyProps: { sourceCheckIn: string; sourceCheckOut: string; minCheckIn: string };
  isDeleted: boolean;
  paymentId: string | null;
  showConfirmPendingGuests: boolean;
  hasSavedPaymentMethod: boolean;
  finalPriceCents: number;
  providerMismatches?: BookingProviderMismatch[];
  features: FeatureFlags;
  /** Admin capacity hold state (#1764); omitted for deleted bookings. */
  capacityHold?: {
    hasAdminCapacityHold: boolean;
    adminCapacityHoldAt: string | null;
    heldByName: string | null;
    holdsCapacityNaturally: boolean;
    canPlaceHold: boolean;
  };
  /** Exclusive whole-lodge hold state (#121); omitted for deleted bookings. */
  exclusiveHold?: {
    wholeLodgeHold: boolean;
    wholeLodgeHoldAt: string | null;
    heldByName: string | null;
    /**
     * Whether the booking holds lodge capacity (#173). The Set control is
     * gated on this — an exclusive hold on a non-holding booking blocks
     * nothing (ADR-001 capacity rule).
     */
    holdsCapacity: boolean;
    /** Overlapping bookings to resolve when the hold is set (issue #119). */
    conflicts?: ExclusiveHoldConflict[];
  };
}) {
  const returnTo = `/bookings/${bookingId}`;
  const bedAllocationParams = new URLSearchParams({
    from: formatDateOnly(checkIn),
    to: formatDateOnly(checkOut),
    bookingId,
  });
  const bedAllocationHref = buildHrefWithReturnTo(
    `/admin/bed-allocation?${bedAllocationParams.toString()}`,
    returnTo,
  );

  return (
    <>
      <Card className="border-slate-300 bg-slate-50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-slate-900">Admin tools</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {providerMismatches.length > 0 && (
            <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <p className="font-medium">Provider state out of step</p>
              {providerMismatches.map((mismatch) => (
                <p key={mismatch.id}>
                  <span className="font-medium">{mismatch.label}.</span>{" "}
                  {mismatch.description}{" "}
                  <Link
                    className="font-medium underline"
                    href={buildHrefWithReturnTo(mismatch.href, returnTo)}
                  >
                    {mismatch.linkLabel}
                  </Link>
                </p>
              ))}
            </div>
          )}
          {!isDeleted && capacityHold && (
            <AdminCapacityHoldControls
              bookingId={bookingId}
              hasAdminCapacityHold={capacityHold.hasAdminCapacityHold}
              adminCapacityHoldAt={capacityHold.adminCapacityHoldAt}
              heldByName={capacityHold.heldByName}
              holdsCapacityNaturally={capacityHold.holdsCapacityNaturally}
              canPlaceHold={capacityHold.canPlaceHold}
            />
          )}
          {!isDeleted && exclusiveHold && (
            <AdminExclusiveHoldControls
              bookingId={bookingId}
              wholeLodgeHold={exclusiveHold.wholeLodgeHold}
              wholeLodgeHoldAt={exclusiveHold.wholeLodgeHoldAt}
              heldByName={exclusiveHold.heldByName}
              holdsCapacity={exclusiveHold.holdsCapacity}
              conflicts={exclusiveHold.conflicts}
            />
          )}
          {!isDeleted && (
            <CopyBookingButton
              bookingId={bookingId}
              sourceCheckIn={copyProps.sourceCheckIn}
              sourceCheckOut={copyProps.sourceCheckOut}
              minCheckIn={copyProps.minCheckIn}
            />
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link
              className="text-slate-700 underline hover:text-slate-900"
              href={buildHrefWithReturnTo(`/admin/members/${memberId}`, returnTo)}
            >
              Member: {memberName}
            </Link>
            {isFeatureHrefVisible(bedAllocationHref, features) ? (
              <Link
                className="text-slate-700 underline hover:text-slate-900"
                href={bedAllocationHref}
              >
                Bed allocation
              </Link>
            ) : null}
            <Link
              className="text-slate-700 underline hover:text-slate-900"
              href={buildXeroRecordActivityUrl(
                paymentId ? "Payment" : "Booking",
                paymentId ?? bookingId,
                returnTo,
              )}
            >
              Xero activity
            </Link>
            <Link
              className="text-slate-700 underline hover:text-slate-900"
              href={`/admin/audit-log?q=${encodeURIComponent(bookingId)}`}
            >
              Audit log
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Admin: force-confirm non-member guests still on hold (issue #708) */}
      {showConfirmPendingGuests && (
        <ConfirmPendingGuestsButton
          bookingId={bookingId}
          hasSavedPaymentMethod={hasSavedPaymentMethod}
          finalPriceCents={finalPriceCents}
        />
      )}
    </>
  );
}
