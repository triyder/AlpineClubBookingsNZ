"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { BookingStatus } from "@prisma/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCents } from "@/lib/utils";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";

export interface MyBookingItem {
  id: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  finalPriceCents: number;
  status: BookingStatus;
  // Split-booking (#738) labelling, pre-computed on the server.
  linkLabel: "linked-parent" | "provisional-child" | "guest-linked" | null;
  // #1975: the provisional child's parent booking id, so the list can nest the
  // child as a sub-row inside the parent's card. Null for parents/standalone.
  parentBookingId: string | null;
}

type SortDir = "desc" | "asc";

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-NZ", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// #1975: the pre-#1975 inline link labels. When a provisional child is nested
// inside its parent's card the "· linked to your member booking" child label
// and the parent's "Includes linked provisional non-member guests" label are
// both redundant (the visual nesting says it), so they are suppressed there and
// only render when the row stands alone (a fallback child row, or a parent
// whose child is filtered/paged out of view).
function LinkLabelText({ linkLabel }: { linkLabel: MyBookingItem["linkLabel"] }) {
  if (linkLabel === "provisional-child") {
    return (
      <p className="text-xs text-sky-700">
        Provisional non-member guests · linked to your member booking
      </p>
    );
  }
  if (linkLabel === "linked-parent") {
    return (
      <p className="text-xs text-sky-700">
        Includes linked provisional non-member guests
      </p>
    );
  }
  if (linkLabel === "guest-linked") {
    return (
      <p className="text-xs text-sky-700">
        You are listed as a guest on this booking
      </p>
    );
  }
  return null;
}

// Shared summary body (dates, party size, price, optional link label, status
// badge). Rendered both for a top-level card and for a nested child sub-row.
function BookingSummary({
  booking,
  showLinkLabel,
}: {
  booking: MyBookingItem;
  showLinkLabel: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="space-y-1">
        <p className="font-medium">
          {formatDate(booking.checkIn)} - {formatDate(booking.checkOut)}
        </p>
        <p className="text-sm text-gray-600">
          {booking.guestCount} guest{booking.guestCount !== 1 ? "s" : ""} &middot;{" "}
          {formatCents(booking.finalPriceCents)}
        </p>
        {showLinkLabel ? <LinkLabelText linkLabel={booking.linkLabel} /> : null}
      </div>
      <Badge variant="secondary" className={bookingStatusClass(booking.status)}>
        {bookingStatusLabel(booking.status)}
      </Badge>
    </div>
  );
}

export function MyBookingsList({ bookings }: { bookings: MyBookingItem[] }) {
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [statusFilter, setStatusFilter] = useState<BookingStatus | "all">("all");

  // Statuses actually present, so the filter only offers useful options.
  const statusOptions = useMemo(() => {
    const seen = new Set<BookingStatus>();
    for (const booking of bookings) seen.add(booking.status);
    return Array.from(seen);
  }, [bookings]);

  const visibleBookings = useMemo(() => {
    const filtered =
      statusFilter === "all"
        ? bookings
        : bookings.filter((booking) => booking.status === statusFilter);
    const direction = sortDir === "asc" ? 1 : -1;
    // Sort by start date with a stable id tiebreaker so equal dates keep a
    // deterministic order (issue #771).
    return [...filtered].sort((a, b) => {
      const byDate =
        (new Date(a.checkIn).getTime() - new Date(b.checkIn).getTime()) * direction;
      return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
    });
  }, [bookings, statusFilter, sortDir]);

  // #1975: nest each provisional child under its parent's card. A child nests
  // only when its parent survives the current filter/sort and is visible; if
  // the parent is filtered or paged out of the visible set, the child falls
  // back to its own top-level row so it never disappears.
  const { topLevel, childrenByParent } = useMemo(() => {
    const visibleIds = new Set(visibleBookings.map((b) => b.id));
    const isNestedChild = (b: MyBookingItem) =>
      b.linkLabel === "provisional-child" &&
      b.parentBookingId !== null &&
      visibleIds.has(b.parentBookingId);

    const childrenByParent = new Map<string, MyBookingItem[]>();
    for (const booking of visibleBookings) {
      if (isNestedChild(booking) && booking.parentBookingId) {
        const existing = childrenByParent.get(booking.parentBookingId) ?? [];
        existing.push(booking);
        childrenByParent.set(booking.parentBookingId, existing);
      }
    }
    const topLevel = visibleBookings.filter((b) => !isNestedChild(b));
    return { topLevel, childrenByParent };
  }, [visibleBookings]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="booking-sort">Sort by start date</Label>
          <Select value={sortDir} onValueChange={(value) => setSortDir(value as SortDir)}>
            <SelectTrigger id="booking-sort" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">Newest first</SelectItem>
              <SelectItem value="asc">Oldest first</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {statusOptions.length > 1 && (
          <div className="space-y-1">
            <Label htmlFor="booking-status">Status</Label>
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as BookingStatus | "all")}
            >
              <SelectTrigger id="booking-status" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {statusOptions.map((status) => (
                  <SelectItem key={status} value={status}>
                    {bookingStatusLabel(status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {visibleBookings.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-gray-600">
            No bookings match the current filter.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {topLevel.map((booking) => {
            const children = childrenByParent.get(booking.id) ?? [];

            // No nested children: keep the pre-#1975 whole-card link unchanged.
            if (children.length === 0) {
              return (
                <Link
                  key={booking.id}
                  href={buildHrefWithReturnTo(`/bookings/${booking.id}`, "/bookings")}
                >
                  <Card className="cursor-pointer transition-shadow hover:shadow-md mb-3">
                    <CardContent className="p-4">
                      <BookingSummary booking={booking} showLinkLabel />
                    </CardContent>
                  </Card>
                </Link>
              );
            }

            // Parent with nested children: the card is a container (not a single
            // link) so the parent link and each child link are separate anchors
            // — nested <a> elements are invalid and break keyboard navigation.
            return (
              <Card key={booking.id} className="mb-3">
                <CardContent className="p-4 space-y-3">
                  <Link
                    href={buildHrefWithReturnTo(`/bookings/${booking.id}`, "/bookings")}
                    className="block rounded-md transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                  >
                    <BookingSummary booking={booking} showLinkLabel={false} />
                  </Link>
                  <div
                    role="group"
                    aria-label="Your non-member guests linked to this booking"
                    className="ml-1 space-y-2 border-l-2 border-sky-200 pl-4"
                  >
                    <p className="text-xs font-medium text-sky-700">
                      Your non-member guests
                    </p>
                    {children.map((child) => (
                      <Link
                        key={child.id}
                        href={buildHrefWithReturnTo(
                          `/bookings/${child.id}`,
                          "/bookings",
                        )}
                        className="block rounded-md border border-sky-100 bg-sky-50/60 p-3 transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                      >
                        <BookingSummary booking={child} showLinkLabel={false} />
                      </Link>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
