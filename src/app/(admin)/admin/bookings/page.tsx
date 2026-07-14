import Link from "next/link";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { cn, formatCents } from "@/lib/utils";
import { BookingFilters } from "@/components/admin/booking-filters";
import { BookingsPagination } from "@/components/admin/bookings-pagination";
import { AdminBookingCalendar } from "@/components/admin-booking-calendar";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import { SortHeader } from "@/components/admin/sort-header";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import {
  adminBookingsQuerySchema,
  getDefaultAdminBookingSortDir,
  listAdminBookings,
  type AdminBookingRow,
  type BookingSortBy,
  type SortDir,
} from "@/lib/admin-bookings-service";
import { buildHrefWithReturnTo, buildPathWithSearch } from "@/lib/internal-return-path";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { lodgeOrderBy } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { APP_TIME_ZONE } from "@/config/operational";
import {
  CalendarX2,
  CreditCard,
  Eye,
  Landmark,
  MinusCircle,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

function formatDate(value: Date) {
  return value.toLocaleDateString("en-NZ", { timeZone: APP_TIME_ZONE });
}

export function formatAdminBookingGuestCount(totalGuests: number, nonMemberGuests: number) {
  return `${totalGuests} (${nonMemberGuests} non-member${nonMemberGuests === 1 ? "" : "s"})`;
}

// Whole lodge nights between two date-only check-in/out values. Both are stored
// as midnight instants, so the raw millisecond span divides to exact nights —
// this is a display-only derivation and never touches the query/money math.
function nightsBetween(checkIn: Date, checkOut: Date) {
  return Math.max(
    0,
    Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000),
  );
}

// Small semantic chip (icon + text) sharing StatusChip's five-tone visual
// language for the non-status signals the redesigned table keeps inline
// (payment source, review, deleted). Meaning is carried by icon + label, never
// colour alone.
type ChipTone = "neutral" | "info" | "success" | "warning" | "danger";

const CHIP_TONE_CLASSES: Record<ChipTone, string> = {
  neutral: "bg-muted text-foreground",
  info: "bg-info-muted text-info",
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  danger: "bg-danger-muted text-danger",
};

function MiniChip({
  tone,
  icon: Icon,
  children,
}: {
  tone: ChipTone;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-transparent px-2 py-0.5 text-xs font-medium",
        CHIP_TONE_CLASSES[tone],
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{children}</span>
    </span>
  );
}

function paymentChip(source: AdminBookingRow["operational"]["paymentSource"]): {
  tone: ChipTone;
  icon: LucideIcon;
  label: string;
} {
  switch (source) {
    case "STRIPE":
      return { tone: "info", icon: CreditCard, label: "Stripe" };
    case "INTERNET_BANKING":
      return { tone: "info", icon: Landmark, label: "Internet Banking" };
    case "NONE":
    default:
      return { tone: "neutral", icon: MinusCircle, label: "No payment" };
  }
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

  // One sortable header wired to the URL-driven sort links this page has always
  // built. `align="right"` keeps the numeric Total header aligned with its cell.
  function BookingSortHeader({
    column,
    children,
    align,
  }: {
    column: BookingSortBy;
    children: ReactNode;
    align?: "left" | "right";
  }) {
    return (
      <SortHeader
        active={sortBy === column}
        direction={sortDir}
        href={sortHref(column)}
        align={align}
      >
        {children}
      </SortHeader>
    );
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="All Bookings"
        actions={
          canEditBookings ? (
            <Link href="/admin/book" className="app-button-brand">
              + Create Booking
            </Link>
          ) : (
            <ViewOnlyActionButton canEdit={false}>+ Create Booking</ViewOnlyActionButton>
          )
        }
      />

      <BookingFilters
        showBedAllocation={showBedAllocation}
        lodgeOptions={activeLodges}
      />

      <AdminBookingCalendar />

      {bookings.length === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <EmptyState
            icon={CalendarX2}
            title="No bookings found"
            description="No bookings match your current filters. Try clearing or adjusting them."
          />
        </div>
      ) : (
        <div className="space-y-2">
          <AdminDataTable
            stickyFirstColumn
            aria-label="Bookings"
            className="min-w-[56rem]"
            toolbar={
              <p>
                Showing {bookings.length} of {total} bookings found
                {totalPages > 1 ? ` (page ${page} of ${totalPages})` : ""}
              </p>
            }
          >
            <TableHeader>
              <TableRow>
                <BookingSortHeader column="member">Member</BookingSortHeader>
                {showLodge ? <TableHead>Lodge</TableHead> : null}
                <BookingSortHeader column="lastUpdated">Last Updated</BookingSortHeader>
                <BookingSortHeader column="checkIn">Stay</BookingSortHeader>
                <BookingSortHeader column="guests">Guests</BookingSortHeader>
                <BookingSortHeader column="total" align="right">Total</BookingSortHeader>
                <BookingSortHeader column="status">Status</BookingSortHeader>
                <TableHead>Payment</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bookings.map((booking) => {
                const nonMemberGuestCount = booking.guests.filter((guest) => !guest.isMember).length;
                const payment = paymentChip(booking.operational.paymentSource);
                const nights = nightsBetween(booking.checkIn, booking.checkOut);

                return (
                  <TableRow key={booking.id}>
                    <TableCell>
                      <Link
                        href={buildHrefWithReturnTo(`/admin/members/${booking.member.id}`, currentBookingsPath)}
                        className="group inline-block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="block text-sm font-medium text-foreground group-hover:text-primary group-hover:underline">
                          {booking.member.firstName} {booking.member.lastName}
                        </span>
                        <span className="block text-xs text-muted-foreground">{booking.member.email}</span>
                      </Link>
                    </TableCell>
                    {showLodge ? (
                      <TableCell className="text-sm">
                        {booking.lodge?.name ?? "—"}
                      </TableCell>
                    ) : null}
                    <TableCell className="text-sm">{formatDate(booking.updatedAt)}</TableCell>
                    <TableCell className="text-sm">
                      <span className="block">{formatDate(booking.checkIn)}</span>
                      <span className="block text-xs text-muted-foreground">to {formatDate(booking.checkOut)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {nights} night{nights === 1 ? "" : "s"}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatAdminBookingGuestCount(booking.guests.length, nonMemberGuestCount)}
                    </TableCell>
                    <TableCell className="text-right text-sm font-medium tabular-nums">
                      {formatCents(booking.finalPriceCents)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link
                          href={buildHrefWithReturnTo(`/bookings/${booking.id}`, currentBookingsPath)}
                          className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <StatusChip kind="booking" value={booking.status} />
                        </Link>
                        {booking.requiresAdminReview ? (
                          <Link
                            href={`/admin/booking-requests?tab=approvals&bookingId=${booking.id}&status=ALL`}
                            className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <MiniChip tone="warning" icon={Eye}>Review</MiniChip>
                          </Link>
                        ) : null}
                        {booking.deletedAt ? (
                          <MiniChip tone="danger" icon={Trash2}>Deleted</MiniChip>
                        ) : null}
                      </div>
                      {booking.requiresAdminReview && booking.adminReviewReason ? (
                        <p className="mt-1 text-xs text-warning">{booking.adminReviewReason}</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <MiniChip tone={payment.tone} icon={payment.icon}>
                        {payment.label}
                      </MiniChip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </AdminDataTable>
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
