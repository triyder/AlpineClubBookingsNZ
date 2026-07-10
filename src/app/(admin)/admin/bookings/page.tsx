import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { formatCents } from "@/lib/utils";
import { BookingFilters } from "@/components/admin/booking-filters";
import { BookingsPagination } from "@/components/admin/bookings-pagination";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { AdminBookingCalendar } from "@/components/admin-booking-calendar";
import {
  adminBookingsQuerySchema,
  getDefaultAdminBookingSortDir,
  listAdminBookings,
  type AdminBookingRow,
  type BookingSortBy,
  type SortDir,
} from "@/lib/admin-bookings-service";
import { formatDateOnly } from "@/lib/date-only";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";
import { buildHrefWithReturnTo, buildPathWithSearch } from "@/lib/internal-return-path";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { lodgeOrderBy } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { APP_TIME_ZONE } from "@/config/operational";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { ReactNode } from "react";

function formatDate(value: Date) {
  return value.toLocaleDateString("en-NZ", { timeZone: APP_TIME_ZONE });
}

export function formatAdminBookingGuestCount(totalGuests: number, nonMemberGuests: number) {
  return `${totalGuests} (${nonMemberGuests} non-member${nonMemberGuests === 1 ? "" : "s"})`;
}

export default async function AdminBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    from?: string;
    to?: string;
    updatedFrom?: string;
    updatedTo?: string;
    checkInFrom?: string;
    checkInTo?: string;
    checkOutFrom?: string;
    checkOutTo?: string;
    search?: string;
    upcoming?: string;
    sort?: string;
    sortBy?: string;
    sortDir?: string;
    month?: string;
    deleted?: string;
    paymentSource?: string;
    xeroState?: string;
    bedState?: string;
    changeState?: string;
    lodgeId?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const parsedQuery = adminBookingsQuerySchema.safeParse(params);
  const query = parsedQuery.success ? parsedQuery.data : adminBookingsQuerySchema.parse({});
  const session = await auth();
  const canEditBookings = session?.user
    ? hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
    : false;
  const effectiveModules = await loadEffectiveModuleFlags();
  const showBedAllocation = effectiveModules.bedAllocation;
  // Lodge filter and column appear only once a second active lodge exists
  // (ADR-002 presentation rule).
  const activeLodges = await prisma.lodge.findMany({
    where: { active: true },
    orderBy: lodgeOrderBy(),
    select: { id: true, name: true },
  });
  const showLodge = activeLodges.length > 1;
  const { bookings, total, page, totalPages, sortBy, sortDir } =
    await listAdminBookings(query, {
      bedAllocationEnabled: showBedAllocation,
    });

  function visibleSearchParams() {
    const currentSearchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value && (showBedAllocation || key !== "bedState")) {
        currentSearchParams.set(key, value);
      }
    }

    return currentSearchParams;
  }
  const currentSearchParams = visibleSearchParams();
  const currentBookingsPath = buildPathWithSearch("/admin/bookings", currentSearchParams);

  function withPage(nextParams: URLSearchParams, targetPage: number) {
    nextParams.delete("page");
    if (targetPage > 1) nextParams.set("page", String(targetPage));
    const queryString = nextParams.toString();
    return queryString ? `/admin/bookings?${queryString}` : "/admin/bookings";
  }

  function sortHref(column: BookingSortBy) {
    const nextParams = visibleSearchParams();

    const nextDir: SortDir = sortBy === column
      ? sortDir === "asc" ? "desc" : "asc"
      : getDefaultAdminBookingSortDir(column);
    nextParams.delete("sort");
    nextParams.set("sortBy", column);
    nextParams.set("sortDir", nextDir);

    // Sorting reorders the same result set, so it keeps the current page
    // (#1738). Normalise to the clamped page from the service so a stale
    // out-of-range `page` in the URL cannot ride along.
    return withPage(nextParams, page);
  }

  function pageHref(targetPage: number) {
    return withPage(visibleSearchParams(), targetPage);
  }

  function SortIcon({ column }: { column: BookingSortBy }) {
    if (sortBy !== column) {
      return <ArrowUpDown className="ml-1 h-3 w-3 opacity-40" />;
    }

    return sortDir === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3" />
    );
  }

  function SortHeader({ column, children }: { column: BookingSortBy; children: ReactNode }) {
    return (
      <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
        <Link href={sortHref(column)} className="inline-flex items-center whitespace-nowrap hover:text-gray-900">
          {children}
          <SortIcon column={column} />
        </Link>
      </th>
    );
  }

  function paymentSourceLabel(source: AdminBookingRow["operational"]["paymentSource"]) {
    if (source === "INTERNET_BANKING") return "Internet Banking";
    if (source === "STRIPE") return "Stripe";
    return "No payment";
  }

  function xeroStateLabel(state: AdminBookingRow["operational"]["xeroState"]) {
    switch (state) {
      case "invoiceLinked":
        return "Invoice linked";
      case "invoiceMissing":
        return "Invoice missing";
      case "operationFailed":
        return "Failed activity";
      case "operationPartial":
        return "Partial activity";
      case "operationPending":
        return "Pending activity";
      case "none":
      default:
        return "No invoice needed";
    }
  }

  function xeroStateClass(state: AdminBookingRow["operational"]["xeroState"]) {
    switch (state) {
      case "invoiceLinked":
        return "bg-green-100 text-green-900";
      case "invoiceMissing":
        return "bg-orange-100 text-orange-900";
      case "operationFailed":
        return "bg-red-100 text-red-900";
      case "operationPartial":
      case "operationPending":
        return "bg-amber-100 text-amber-900";
      case "none":
      default:
        return "bg-slate-100 text-slate-700";
    }
  }

  function bedStateLabel(booking: AdminBookingRow) {
    const { bedState, allocatedGuestNights, expectedGuestNights } = booking.operational;
    const countLabel = expectedGuestNights > 0
      ? ` ${allocatedGuestNights}/${expectedGuestNights}`
      : "";

    switch (bedState) {
      case "warning":
        return `Bed warning${countLabel}`;
      case "unallocated":
        return `Unallocated${countLabel}`;
      case "partial":
        return `Partial${countLabel}`;
      case "complete":
      default:
        return `Allocated${countLabel}`;
    }
  }

  function bedStateClass(state: AdminBookingRow["operational"]["bedState"]) {
    switch (state) {
      case "warning":
        return "bg-amber-100 text-amber-900";
      case "unallocated":
        return "bg-red-100 text-red-900";
      case "partial":
        return "bg-orange-100 text-orange-900";
      case "complete":
      default:
        return "bg-green-100 text-green-900";
    }
  }

  function bedAllocationHref(booking: AdminBookingRow) {
    const params = new URLSearchParams({
      from: formatDateOnly(booking.checkIn),
      to: formatDateOnly(booking.checkOut),
      bookingId: booking.id,
    });
    return buildHrefWithReturnTo(`/admin/bed-allocation?${params.toString()}`, currentBookingsPath);
  }

  function xeroActivityHref(booking: AdminBookingRow) {
    return booking.payment
      ? buildXeroRecordActivityUrl("Payment", booking.payment.id, currentBookingsPath)
      : buildXeroRecordActivityUrl("Booking", booking.id, currentBookingsPath);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">All Bookings</h1>
        {canEditBookings ? (
          <Link
            href="/admin/book"
            className="app-button-brand"
          >
            + Create Booking
          </Link>
        ) : (
          <ViewOnlyActionButton canEdit={false}>+ Create Booking</ViewOnlyActionButton>
        )}
      </div>

      <BookingFilters
        showBedAllocation={showBedAllocation}
        lodgeOptions={activeLodges}
      />

      <AdminBookingCalendar />

      {bookings.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-gray-500">
            No bookings found matching your filters.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-gray-500">
            Showing {bookings.length} of {total} bookings found
            {totalPages > 1 ? ` (page ${page} of ${totalPages})` : ""}
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 bg-white rounded-lg shadow">
              <thead className="bg-gray-50">
                <tr>
                  <SortHeader column="member">Member</SortHeader>
                  {showLodge ? (
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Lodge</th>
                  ) : null}
                  <SortHeader column="lastUpdated">Last Updated</SortHeader>
                  <SortHeader column="checkIn">Check In</SortHeader>
                  <SortHeader column="guests">Guests</SortHeader>
                  <SortHeader column="total">Total</SortHeader>
                  <SortHeader column="status">Status</SortHeader>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Payment</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Xero</th>
                  {showBedAllocation ? (
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Beds</th>
                  ) : null}
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Changes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {bookings.map((booking) => {
                  const nonMemberGuestCount = booking.guests.filter((guest) => !guest.isMember).length;

                  return (
                    <tr key={booking.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link
                          href={buildHrefWithReturnTo(`/admin/members/${booking.member.id}`, currentBookingsPath)}
                          className="hover:underline"
                        >
                          <p className="font-medium text-sm text-blue-600">
                            {booking.member.firstName} {booking.member.lastName}
                          </p>
                          <p className="text-xs text-gray-500">{booking.member.email}</p>
                        </Link>
                      </td>
                      {showLodge ? (
                        <td className="px-4 py-3 text-sm">
                          {booking.lodge?.name ?? "—"}
                        </td>
                      ) : null}
                      <td className="px-4 py-3 text-sm">{formatDate(booking.updatedAt)}</td>
                      <td className="px-4 py-3 text-sm">
                        <p>{formatDate(booking.checkIn)}</p>
                        <p className="text-xs text-gray-500">to {formatDate(booking.checkOut)}</p>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {formatAdminBookingGuestCount(booking.guests.length, nonMemberGuestCount)}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium">{formatCents(booking.finalPriceCents)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={buildHrefWithReturnTo(`/bookings/${booking.id}`, currentBookingsPath)}
                            className="inline-flex"
                          >
                            <Badge variant="secondary" className={`${bookingStatusClass(booking.status)} cursor-pointer`}>
                              {bookingStatusLabel(booking.status)}
                            </Badge>
                          </Link>
                          {booking.requiresAdminReview ? (
                            <Link href={`/admin/booking-requests?tab=approvals&bookingId=${booking.id}&status=ALL`}>
                              <Badge variant="secondary" className="bg-amber-100 text-amber-900 cursor-pointer hover:bg-amber-200">
                                Review
                              </Badge>
                            </Link>
                          ) : null}
                          {booking.deletedAt ? (
                            <Badge variant="secondary" className="bg-red-100 text-red-900">
                              Deleted
                            </Badge>
                          ) : null}
                        </div>
                        {booking.requiresAdminReview && booking.adminReviewReason ? (
                          <p className="mt-1 text-xs text-amber-800">{booking.adminReviewReason}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <div className="flex flex-wrap gap-1">
                          <Badge
                            variant="secondary"
                            className={
                              booking.operational.paymentSource === "NONE"
                                ? "bg-slate-100 text-slate-700"
                                : "bg-blue-100 text-blue-900"
                            }
                          >
                            {paymentSourceLabel(booking.operational.paymentSource)}
                          </Badge>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <div className="flex flex-col gap-1">
                          <Link href={xeroActivityHref(booking)} className="inline-flex">
                            <Badge
                              variant="secondary"
                              className={`${xeroStateClass(booking.operational.xeroState)} cursor-pointer`}
                            >
                              {xeroStateLabel(booking.operational.xeroState)}
                            </Badge>
                          </Link>
                          {booking.operational.xeroActivity.failed > 0 ? (
                            <Link
                              href={buildXeroRecordActivityUrl("Booking", booking.id, currentBookingsPath)}
                              className="text-xs text-red-700 hover:underline"
                            >
                              {booking.operational.xeroActivity.failed} failed
                            </Link>
                          ) : null}
                          {booking.operational.xeroActivity.partial > 0 ? (
                            <Link
                              href={buildXeroRecordActivityUrl("Booking", booking.id, currentBookingsPath)}
                              className="text-xs text-amber-700 hover:underline"
                            >
                              {booking.operational.xeroActivity.partial} partial
                            </Link>
                          ) : null}
                          {booking.operational.xeroActivity.pending > 0 ? (
                            <Link
                              href={buildXeroRecordActivityUrl("Booking", booking.id, currentBookingsPath)}
                              className="text-xs text-slate-700 hover:underline"
                            >
                              {booking.operational.xeroActivity.pending} pending
                            </Link>
                          ) : null}
                        </div>
                      </td>
                      {showBedAllocation ? (
                        <td className="px-4 py-3 text-sm">
                          <div className="space-y-1">
                            <Link href={bedAllocationHref(booking)} className="inline-flex">
                              <Badge
                                variant="secondary"
                                className={`${bedStateClass(booking.operational.bedState)} cursor-pointer`}
                              >
                                {bedStateLabel(booking)}
                              </Badge>
                            </Link>
                            {booking.operational.unapprovedBedAllocations > 0 ? (
                              <p className="text-xs text-amber-700">
                                {booking.operational.unapprovedBedAllocations} awaiting approval
                              </p>
                            ) : null}
                            {booking.operational.hasPerGuestDates ? (
                              <div className="space-y-0.5">
                                <Badge variant="outline" className="text-xs">
                                  Per-guest dates
                                </Badge>
                                {booking.operational.guestDateRanges.slice(0, 2).map((guestRange) => (
                                  <p key={guestRange.guestId} className="text-xs text-gray-500">
                                    {guestRange.guestName}: {guestRange.stayStart} to {guestRange.stayEnd}
                                  </p>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                      <td className="px-4 py-3 text-sm">
                        <div className="flex flex-wrap gap-1">
                          {booking.operational.pendingChangeRequest ? (
                            <Link href={`/admin/booking-change-requests?bookingId=${booking.id}&status=REQUESTED`}>
                              <Badge variant="secondary" className="bg-amber-100 text-amber-900 cursor-pointer hover:bg-amber-200">
                                Request
                              </Badge>
                            </Link>
                          ) : null}
                          {booking.operational.hasModification ? (
                            <Badge variant="secondary" className="bg-slate-100 text-slate-800">
                              Modified
                            </Badge>
                          ) : null}
                          {booking.operational.creditGenerated ? (
                            <Badge variant="secondary" className="bg-green-100 text-green-900">
                              Credit
                            </Badge>
                          ) : null}
                          {booking.operational.refundGenerated ? (
                            <Badge variant="secondary" className="bg-blue-100 text-blue-900">
                              Refund
                            </Badge>
                          ) : null}
                          {!booking.operational.pendingChangeRequest &&
                          !booking.operational.hasModification &&
                          !booking.operational.creditGenerated &&
                          !booking.operational.refundGenerated ? (
                            <span className="text-xs text-gray-500">-</span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <BookingsPagination
            page={page}
            totalPages={totalPages}
            total={total}
            hrefForPage={pageHref}
          />
        </div>
      )}
    </div>
  );
}
