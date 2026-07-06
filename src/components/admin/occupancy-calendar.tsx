"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateOnly, getTodayDateOnly, parseDateOnly } from "@/lib/date-only";
import { APP_LOCALE } from "@/config/operational";
import { CalendarDays, ChevronLeft, ChevronRight, Users } from "lucide-react";

export type OccupancyCalendarMode = "range" | "single";

export type OccupancyCalendarBooking = {
  id: string;
  reference: string;
  ownerName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: string;
};

type OccupancyCalendarNight = {
  date: string;
  guestCount: number;
  bookings: OccupancyCalendarBooking[];
};

type OccupancyCalendarResponse = {
  month: string;
  nights: OccupancyCalendarNight[];
  bookings: OccupancyCalendarBooking[];
};

type OccupancyCalendarProps = {
  mode: OccupancyCalendarMode;
  selectedStartDate?: string;
  selectedEndDate?: string;
  onSelectionChange: (selection: { startDate: string; endDate: string }) => void;
};

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getMonthStart(date: Date) {
  return parseDateOnly(`${monthKey(date)}-01`);
}

function getMonthGrid(year: number, monthIndex: number) {
  const firstDay = new Date(Date.UTC(year, monthIndex, 1));
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const day = firstDay.getUTCDay();
  const startOffset = day === 0 ? 6 : day - 1;
  return { daysInMonth, startOffset };
}

function formatDisplayDate(dateString: string) {
  return parseDateOnly(dateString).toLocaleDateString(APP_LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function overlapsSelection(
  booking: OccupancyCalendarBooking,
  startDate: string,
  endDate: string,
) {
  return booking.checkIn <= endDate && booking.checkOut > startDate;
}

function uniqueBookings(bookings: OccupancyCalendarBooking[]) {
  return [...new Map(bookings.map((booking) => [booking.id, booking])).values()];
}

export function OccupancyCalendar({
  mode,
  selectedStartDate,
  selectedEndDate,
  onSelectionChange,
}: OccupancyCalendarProps) {
  const today = formatDateOnly(getTodayDateOnly());
  const initialMonth = selectedStartDate ? parseDateOnly(selectedStartDate) : getTodayDateOnly();
  const [visibleMonth, setVisibleMonth] = useState(() => getMonthStart(initialMonth));
  const [occupancy, setOccupancy] = useState<OccupancyCalendarResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedStartDate) return;
    const parsed = parseDateOnly(selectedStartDate);
    if (!Number.isNaN(parsed.getTime())) {
      setVisibleMonth(getMonthStart(parsed));
    }
  }, [selectedStartDate]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");

    fetch(`/api/admin/occupancy?month=${monthKey(visibleMonth)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load occupancy");
        return res.json() as Promise<OccupancyCalendarResponse>;
      })
      .then((data) => {
        if (!cancelled) setOccupancy(data);
      })
      .catch(() => {
        if (!cancelled) {
          setOccupancy(null);
          setLoadError("Occupancy could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [visibleMonth]);

  const nightsByDate = useMemo(() => {
    return new Map((occupancy?.nights ?? []).map((night) => [night.date, night]));
  }, [occupancy]);

  const selectedPanelRange = useMemo(() => {
    if (!selectedStartDate) return null;
    const endDate = mode === "single" ? selectedStartDate : selectedEndDate || selectedStartDate;
    if (endDate < selectedStartDate) return null;
    return { startDate: selectedStartDate, endDate };
  }, [mode, selectedEndDate, selectedStartDate]);

  const selectedBookings = useMemo(() => {
    if (!selectedPanelRange || !occupancy) return [];
    const nightBookings = occupancy.nights
      .filter(
        (night) =>
          night.date >= selectedPanelRange.startDate &&
          night.date <= selectedPanelRange.endDate,
      )
      .flatMap((night) => night.bookings);
    const fallbackBookings = occupancy.bookings.filter((booking) =>
      overlapsSelection(
        booking,
        selectedPanelRange.startDate,
        selectedPanelRange.endDate,
      ),
    );
    return uniqueBookings([...nightBookings, ...fallbackBookings]);
  }, [occupancy, selectedPanelRange]);

  const selectedGuestCount = useMemo(() => {
    if (!selectedPanelRange || !occupancy) return 0;
    return occupancy.nights
      .filter(
        (night) =>
          night.date >= selectedPanelRange.startDate &&
          night.date <= selectedPanelRange.endDate,
      )
      .reduce((total, night) => total + night.guestCount, 0);
  }, [occupancy, selectedPanelRange]);

  function moveMonth(delta: number) {
    setVisibleMonth((current) =>
      new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + delta, 1)),
    );
  }

  function handleDayClick(dateString: string) {
    if (dateString < today) return;

    if (mode === "single") {
      setRangeAnchor(null);
      onSelectionChange({ startDate: dateString, endDate: dateString });
      return;
    }

    if (!rangeAnchor || selectedEndDate) {
      setRangeAnchor(dateString);
      onSelectionChange({ startDate: dateString, endDate: "" });
      return;
    }

    if (dateString < rangeAnchor) {
      setRangeAnchor(dateString);
      onSelectionChange({ startDate: dateString, endDate: "" });
      return;
    }

    onSelectionChange({ startDate: rangeAnchor, endDate: dateString });
    setRangeAnchor(null);
  }

  const year = visibleMonth.getUTCFullYear();
  const monthIndex = visibleMonth.getUTCMonth();
  const { daysInMonth, startOffset } = getMonthGrid(year, monthIndex);
  const visibleMonthLabel = visibleMonth.toLocaleDateString(APP_LOCALE, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => moveMonth(-1)}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-36 text-center text-sm font-semibold text-slate-900">
            {visibleMonthLabel}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => moveMonth(1)}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <CalendarDays className="h-4 w-4" />
          {loading ? "Loading occupancy..." : "Operational bookings only"}
        </div>
      </div>

      {loadError && (
        <div className="border-b border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-7 border-b border-slate-200">
        {DAY_LABELS.map((label) => (
          <div key={label} className="px-1 py-2 text-center text-xs font-medium text-slate-500">
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {Array.from({ length: startOffset }).map((_, index) => (
          <div key={`empty-${index}`} className="min-h-16 border-b border-r border-slate-100 bg-slate-50" />
        ))}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const day = index + 1;
          const dateString = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const night = nightsByDate.get(dateString);
          const isPast = dateString < today;
          const isSelectedStart = dateString === selectedStartDate;
          const isSelectedEnd = dateString === selectedEndDate;
          const isInRange = Boolean(
            selectedStartDate &&
              selectedEndDate &&
              dateString > selectedStartDate &&
              dateString < selectedEndDate,
          );
          const hasGuests = Boolean(night?.guestCount);
          const selectionClass =
            isSelectedStart || isSelectedEnd
              ? "border-blue-600 bg-blue-600 text-white"
              : isInRange
                ? "border-blue-200 bg-blue-50 text-blue-900"
                : hasGuests
                  ? "border-emerald-200 bg-emerald-50 text-slate-900 hover:bg-emerald-100"
                  : "border-slate-100 bg-white text-slate-700 hover:bg-slate-50";
          const guestLabel = night?.guestCount
            ? `${night.guestCount} guest${night.guestCount === 1 ? "" : "s"}`
            : "No guests";

          return (
            <button
              key={dateString}
              type="button"
              disabled={isPast}
              onClick={() => handleDayClick(dateString)}
              aria-pressed={isSelectedStart || isSelectedEnd || isInRange}
              aria-label={`${formatDisplayDate(dateString)}, ${guestLabel}${isPast ? ", past date" : ""}`}
              className={`min-h-16 border-b border-r p-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-300 ${selectionClass}`}
            >
              <span className="block text-sm font-semibold leading-none">{day}</span>
              {hasGuests && (
                <span className={`mt-2 inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${
                  isSelectedStart || isSelectedEnd ? "bg-white/20 text-white" : "bg-emerald-100 text-emerald-800"
                }`}>
                  <Users className="mr-1 h-3 w-3" />
                  {night?.guestCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="space-y-3 px-3 py-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1">
            <span className="h-3 w-3 rounded bg-emerald-100 ring-1 ring-emerald-200" />
            Guests staying
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-3 w-3 rounded bg-blue-600" />
            Selected {mode === "single" ? "date" : "range"}
          </span>
        </div>

        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Who&apos;s at the lodge</h3>
              <p className="text-xs text-slate-500">
                {selectedPanelRange
                  ? `${selectedPanelRange.startDate} to ${selectedPanelRange.endDate}`
                  : mode === "single"
                    ? "Select a date to see bookings."
                    : "Select a start and end date to see bookings."}
              </p>
            </div>
            {selectedPanelRange && (
              <Badge variant="outline" className="bg-white">
                {selectedGuestCount} guest-night{selectedGuestCount === 1 ? "" : "s"}
              </Badge>
            )}
          </div>

          {selectedPanelRange && selectedBookings.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No operational bookings in this selection.</p>
          ) : selectedPanelRange ? (
            <div className="mt-3 divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
              {selectedBookings.map((booking) => (
                <Link
                  key={booking.id}
                  href={`/bookings/${booking.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-slate-50"
                >
                  <span>
                    <span className="font-medium text-slate-900">{booking.ownerName}</span>
                    <span className="ml-2 text-xs text-slate-500">#{booking.reference}</span>
                  </span>
                  <span className="text-xs text-slate-600">
                    {booking.checkIn} to {booking.checkOut} - {booking.guestCount} guest
                    {booking.guestCount === 1 ? "" : "s"}
                  </span>
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
