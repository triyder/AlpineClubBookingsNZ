"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateOnly, getTodayDateOnly, parseDateOnly } from "@/lib/date-only";
import { APP_LOCALE } from "@/config/operational";
import { CalendarDays, ChevronLeft, ChevronRight, Users } from "lucide-react";

type OccupancyCalendarMode = "range" | "single";

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

function monthKeysForDateRange(startDate: string, endDate: string) {
  const start = getMonthStart(parseDateOnly(startDate));
  const end = getMonthStart(parseDateOnly(endDate));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return [];
  }

  const keys: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    keys.push(monthKey(cursor));
    cursor = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
    );
  }
  return keys;
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

export function OccupancyCalendar({
  mode,
  selectedStartDate,
  selectedEndDate,
  onSelectionChange,
}: OccupancyCalendarProps) {
  const today = formatDateOnly(getTodayDateOnly());
  const initialMonth = selectedStartDate ? parseDateOnly(selectedStartDate) : getTodayDateOnly();
  const [visibleMonth, setVisibleMonth] = useState(() => getMonthStart(initialMonth));
  const [occupancyByMonth, setOccupancyByMonth] = useState<
    Record<string, OccupancyCalendarResponse>
  >({});
  const [loadingMonthKeys, setLoadingMonthKeys] = useState<string[]>([]);
  const [failedMonthKeys, setFailedMonthKeys] = useState<string[]>([]);
  const [loadError, setLoadError] = useState("");
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  const requestedMonthKeys = useRef(new Set<string>());
  const visibleMonthKey = monthKey(visibleMonth);

  useEffect(() => {
    if (!selectedStartDate) return;
    const parsed = parseDateOnly(selectedStartDate);
    if (!Number.isNaN(parsed.getTime())) {
      setVisibleMonth(getMonthStart(parsed));
    }
  }, [selectedStartDate]);

  const loadMonth = useCallback((month: string) => {
    if (requestedMonthKeys.current.has(month)) {
      return undefined;
    }

    let cancelled = false;
    requestedMonthKeys.current.add(month);
    setLoadingMonthKeys((current) =>
      current.includes(month) ? current : [...current, month],
    );
    setFailedMonthKeys((current) => current.filter((key) => key !== month));
    setLoadError("");

    fetch(`/api/admin/occupancy?month=${month}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load occupancy");
        return res.json() as Promise<OccupancyCalendarResponse>;
      })
      .then((data) => {
        if (!cancelled) {
          setOccupancyByMonth((current) => ({
            ...current,
            [month]: data,
          }));
          setFailedMonthKeys((current) => current.filter((key) => key !== month));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailedMonthKeys((current) =>
            current.includes(month) ? current : [...current, month],
          );
          setLoadError("Occupancy could not be loaded.");
        }
      })
      .finally(() => {
        requestedMonthKeys.current.delete(month);
        if (!cancelled) {
          setLoadingMonthKeys((current) => current.filter((key) => key !== month));
        }
      });

    return () => {
      cancelled = true;
      requestedMonthKeys.current.delete(month);
    };
  }, []);

  useEffect(() => {
    if (!occupancyByMonth[visibleMonthKey]) {
      return loadMonth(visibleMonthKey);
    }
    setLoadError("");
    return undefined;
  }, [loadMonth, occupancyByMonth, visibleMonthKey]);

  const visibleOccupancy = occupancyByMonth[visibleMonthKey] ?? null;

  const nightsByDate = useMemo(() => {
    return new Map(
      (visibleOccupancy?.nights ?? []).map((night) => [night.date, night]),
    );
  }, [visibleOccupancy]);

  const selectedPanelRange = useMemo(() => {
    if (!selectedStartDate) return null;
    const endDate = mode === "single" ? selectedStartDate : selectedEndDate || selectedStartDate;
    if (endDate < selectedStartDate) return null;
    return { startDate: selectedStartDate, endDate };
  }, [mode, selectedEndDate, selectedStartDate]);

  const selectedMonthKeys = useMemo(() => {
    if (!selectedPanelRange) return [];
    return monthKeysForDateRange(
      selectedPanelRange.startDate,
      selectedPanelRange.endDate,
    );
  }, [selectedPanelRange]);
  const selectedMonthKeySignature = selectedMonthKeys.join("|");

  useEffect(() => {
    const months = selectedMonthKeySignature
      ? selectedMonthKeySignature.split("|")
      : [];
    for (const month of months) {
      if (!occupancyByMonth[month]) {
        return loadMonth(month);
      }
    }
    return undefined;
  }, [loadMonth, occupancyByMonth, selectedMonthKeySignature]);

  const selectedOccupancyMonths = useMemo(
    () =>
      selectedMonthKeys
        .map((month) => occupancyByMonth[month])
        .filter(
          (occupancy): occupancy is OccupancyCalendarResponse => Boolean(occupancy),
        ),
    [occupancyByMonth, selectedMonthKeys],
  );

  const selectedBookings = useMemo(() => {
    if (!selectedPanelRange) return [];
    const bookingTotals = new Map<string, OccupancyCalendarBooking>();
    for (const occupancy of selectedOccupancyMonths) {
      for (const night of occupancy.nights) {
        if (
          night.date < selectedPanelRange.startDate ||
          night.date > selectedPanelRange.endDate
        ) {
          continue;
        }
        for (const booking of night.bookings) {
          const existing = bookingTotals.get(booking.id);
          bookingTotals.set(booking.id, {
            ...booking,
            guestCount: (existing?.guestCount ?? 0) + booking.guestCount,
          });
        }
      }
    }
    return [...bookingTotals.values()];
  }, [selectedOccupancyMonths, selectedPanelRange]);

  const selectedGuestCount = useMemo(() => {
    if (!selectedPanelRange) return 0;
    return selectedOccupancyMonths
      .flatMap((occupancy) => occupancy.nights)
      .filter(
        (night) =>
          night.date >= selectedPanelRange.startDate &&
          night.date <= selectedPanelRange.endDate,
      )
      .reduce((total, night) => total + night.guestCount, 0);
  }, [selectedOccupancyMonths, selectedPanelRange]);

  const selectedRangeLoading = Boolean(
    selectedPanelRange &&
      selectedMonthKeys.some(
        (month) =>
          loadingMonthKeys.includes(month) ||
          (!occupancyByMonth[month] && !failedMonthKeys.includes(month)),
      ),
  );
  const selectedRangeLoadFailed = Boolean(
    selectedPanelRange &&
      selectedMonthKeys.some(
        (month) => failedMonthKeys.includes(month) && !occupancyByMonth[month],
      ),
  );

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
          {loadingMonthKeys.includes(visibleMonthKey)
            ? "Loading occupancy..."
            : "Operational bookings only"}
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
                {selectedRangeLoading
                  ? "Loading..."
                  : `${selectedGuestCount} guest-night${selectedGuestCount === 1 ? "" : "s"}`}
              </Badge>
            )}
          </div>

          {selectedRangeLoading ? (
            <p className="mt-3 text-sm text-slate-500">
              Loading occupancy for this selection...
            </p>
          ) : selectedRangeLoadFailed ? (
            <p className="mt-3 text-sm text-red-700">
              Occupancy could not be loaded for this selection.
            </p>
          ) : selectedPanelRange && selectedBookings.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No operational bookings in this selection.</p>
          ) : selectedPanelRange ? (
            <div className="mt-3 divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
              {selectedBookings.map((booking) => {
                const isSingleNight =
                  selectedPanelRange.startDate === selectedPanelRange.endDate;
                return (
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
                      {booking.checkIn} to {booking.checkOut} - {booking.guestCount}{" "}
                      {isSingleNight ? "guest" : "guest-night"}
                      {booking.guestCount === 1 ? "" : "s"}
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
