import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmPendingGuestsButton } from "@/components/admin/confirm-pending-guests-button";
import { CopyBookingButton } from "@/components/admin/copy-booking-button";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";
import { formatDateOnly } from "@/lib/date-only";

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
}) {
  const returnTo = `/bookings/${bookingId}`;
  const bedAllocationParams = new URLSearchParams({
    from: formatDateOnly(checkIn),
    to: formatDateOnly(checkOut),
    bookingId,
  });

  return (
    <>
      <Card className="border-slate-300 bg-slate-50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-slate-900">Admin tools</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
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
            <Link
              className="text-slate-700 underline hover:text-slate-900"
              href={buildHrefWithReturnTo(
                `/admin/bed-allocation?${bedAllocationParams.toString()}`,
                returnTo,
              )}
            >
              Bed allocation
            </Link>
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
        />
      )}
    </>
  );
}
