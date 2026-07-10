"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useClubIdentity } from "@/components/club-identity-provider";
import { APP_LOCALE } from "@/config/operational";
import { formatLocalDateOnly } from "@/lib/date-only";

interface SeasonInfo {
  name: string;
  type: string;
}

interface BookingCalendarProps {
  onDateSelect: (checkIn: Date, checkOut: Date) => void;
  selectedCheckIn?: Date | null;
  selectedCheckOut?: Date | null;
  // Lodge whose availability and seasons the calendar shows (multi-lodge
  // phase 8). Omitted/null = the club's default lodge.
  lodgeId?: string | null;
  // Admin retroactive booking (#1695): when true, days back to 365 days before
  // today become selectable (muted, warn-and-confirm on full nights). Default
  // false keeps the member flow byte-identical.
  allowPastDates?: boolean;
}

// Retroactive bookings may reach at most this many days into the past. Kept in
// sync with RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS on the server (#1695).
const RETROACTIVE_LOOKBACK_DAYS = 365;

export function BookingCalendar({ onDateSelect, selectedCheckIn, selectedCheckOut, lodgeId, allowPastDates = false }: BookingCalendarProps) {
  const { lodgeCapacity } = useClubIdentity();
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [availability, setAvailability] = useState<Record<string, number>>({});
  const [seasons, setSeasons] = useState<Record<string, SeasonInfo>>({});
  const [selecting, setSelecting] = useState<"checkIn" | "checkOut">("checkIn");
  const [checkIn, setCheckIn] = useState<Date | null>(selectedCheckIn || null);
  const [checkOut, setCheckOut] = useState<Date | null>(selectedCheckOut || null);

  useEffect(() => {
    let cancelled = false;

    async function loadAvailability() {
      const res = await fetch(
        `/api/availability?year=${currentMonth.year}&month=${currentMonth.month}${
          lodgeId ? `&lodgeId=${encodeURIComponent(lodgeId)}` : ""
        }`
      );
      if (!res.ok || cancelled) {
        return;
      }

      const data = await res.json();
      if (!cancelled) {
        setAvailability(data.availability ?? {});
        setSeasons(data.seasons ?? {});
      }
    }

    void loadAvailability();

    return () => {
      cancelled = true;
    };
  }, [currentMonth.month, currentMonth.year, lodgeId]);

  const daysInMonth = new Date(currentMonth.year, currentMonth.month + 1, 0).getDate();
  const firstDay = new Date(currentMonth.year, currentMonth.month, 1).getDay();
  // Adjust for Monday start (0=Mon, 6=Sun)
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Earliest clickable day. Under the retroactive flag this drops 365 days back
  // (local-date math, consistent with `today`); otherwise it is today.
  const minSelectable = new Date(today);
  if (allowPastDates) {
    minSelectable.setDate(minSelectable.getDate() - RETROACTIVE_LOOKBACK_DAYS);
  }

  function handleDayClick(day: number) {
    const date = new Date(currentMonth.year, currentMonth.month, day);
    date.setHours(0, 0, 0, 0);

    if (date < minSelectable) return;

    if (selecting === "checkIn") {
      setCheckIn(date);
      setCheckOut(null);
      setSelecting("checkOut");
    } else {
      if (checkIn && date > checkIn) {
        setCheckOut(date);
        setSelecting("checkIn");
        onDateSelect(checkIn, date);
      } else {
        // If selected date is before checkIn, treat as new checkIn
        setCheckIn(date);
        setCheckOut(null);
        setSelecting("checkOut");
      }
    }
  }

  function getDayClass(day: number, available: number, isPast: boolean, isRetroPast: boolean, dateStr: string) {
    const date = new Date(currentMonth.year, currentMonth.month, day);
    date.setHours(0, 0, 0, 0);

    const season = seasons[dateStr];

    let classes = "flex flex-col items-center justify-center h-12 w-10 rounded-md text-sm font-medium transition-colors ";

    // Season top-border indicator
    if (season?.type === "WINTER") {
      classes += "border-t-2 border-blue-400 ";
    } else if (season?.type === "SUMMER") {
      classes += "border-t-2 border-amber-400 ";
    }

    if (isPast) {
      classes += "text-gray-300 cursor-not-allowed ";
    } else if (isRetroPast) {
      // Muted-but-clickable tint for a past date open to retroactive booking:
      // distinct from the availability colours and the disabled/full grey.
      classes += "bg-slate-100 text-slate-500 italic hover:bg-slate-200 cursor-pointer ";
    } else if (available <= 0) {
      classes += "bg-gray-100 text-gray-400 cursor-not-allowed ";
    } else if (available <= 5) {
      classes += "bg-red-100 text-red-700 hover:bg-red-200 cursor-pointer ";
    } else if (available <= 15) {
      classes += "bg-amber-100 text-amber-800 hover:bg-amber-200 cursor-pointer ";
    } else {
      classes += "bg-green-100 text-green-800 hover:bg-green-200 cursor-pointer ";
    }

    // Highlight selected range
    if (checkIn && date.getTime() === checkIn.getTime()) {
      classes += "!bg-blue-600 !text-white !border-blue-600 ";
    } else if (checkOut && date.getTime() === checkOut.getTime()) {
      classes += "!bg-blue-600 !text-white !border-blue-600 ";
    } else if (checkIn && checkOut && date > checkIn && date < checkOut) {
      classes += "!bg-blue-100 ";
    }

    return classes;
  }

  function prevMonth() {
    setCurrentMonth((prev) => {
      if (prev.month === 0) return { year: prev.year - 1, month: 11 };
      return { ...prev, month: prev.month - 1 };
    });
  }

  function nextMonth() {
    setCurrentMonth((prev) => {
      if (prev.month === 11) return { year: prev.year + 1, month: 0 };
      return { ...prev, month: prev.month + 1 };
    });
  }

  const monthName = new Date(currentMonth.year, currentMonth.month).toLocaleDateString(APP_LOCALE, {
    month: "long",
    year: "numeric",
  });

  // Unique seasons visible in the current month for the legend
  const uniqueSeasons = [...new Map(Object.values(seasons).map((s) => [s.name, s])).values()];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={prevMonth}>
          &lsaquo; Prev
        </Button>
        <h3 className="text-lg font-semibold">{monthName}</h3>
        <Button variant="outline" size="sm" onClick={nextMonth}>
          Next &rsaquo;
        </Button>
      </div>

      <div aria-live="polite" className="text-sm text-gray-600">
        {selecting === "checkIn" ? "Select check-in date" : "Select check-out date"}
      </div>

      <div className="grid grid-cols-7 justify-items-center gap-1 text-center">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="w-10 py-2 text-xs font-medium text-gray-500">
            {d}
          </div>
        ))}

        {Array.from({ length: startOffset }).map((_, i) => (
          <div key={`empty-${i}`} />
        ))}

        {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
          const date = new Date(currentMonth.year, currentMonth.month, day);
          date.setHours(0, 0, 0, 0);
          const dateStr = formatLocalDateOnly(date);
          const occupied = availability[dateStr] ?? 0;
          const available = lodgeCapacity - occupied;
          // A day before the earliest selectable day stays disabled; a past day
          // still inside the retroactive window is clickable but muted (#1695).
          const isPast = date < minSelectable;
          const isRetroPast = allowPastDates && !isPast && date < today;
          const dateLabel = date.toLocaleDateString(APP_LOCALE, {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          });
          const isCheckIn = Boolean(
            checkIn && date.getTime() === checkIn.getTime(),
          );
          const isCheckOut = Boolean(
            checkOut && date.getTime() === checkOut.getTime(),
          );
          const inRange = Boolean(
            checkIn && checkOut && date > checkIn && date < checkOut,
          );
          // Convey the visual blue selection to screen readers, which otherwise
          // only hear the availability label and can't tell which day is chosen.
          const selectionSuffix = isCheckIn
            ? ", selected as check-in"
            : isCheckOut
              ? ", selected as check-out"
              : inRange
                ? ", within your selected stay"
                : "";
          const retroSuffix = isRetroPast
            ? ", past date — retroactive booking"
            : "";
          const dayLabel =
            (isPast
              ? `${dateLabel}, unavailable`
              : available <= 0
                ? `${dateLabel}, full`
                : `${dateLabel}, ${available} of ${lodgeCapacity} beds free`) +
            retroSuffix +
            selectionSuffix;

          return (
            <button
              key={day}
              onClick={() => handleDayClick(day)}
              className={getDayClass(day, available, isPast, isRetroPast, dateStr)}
              // Full past nights stay clickable under the retroactive flag —
              // over-capacity is warn-and-confirm at submit, not a hard block.
              disabled={isPast || (available <= 0 && !allowPastDates)}
              aria-label={dayLabel}
              aria-pressed={isCheckIn || isCheckOut}
            >
              <span aria-hidden="true" className="leading-none">{day}</span>
              {!isPast && (
                <span aria-hidden="true" className="text-xs leading-none mt-0.5">
                  {available}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Availability legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-green-100" /> Available (&gt;15 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-amber-100" /> Moderate (6-15 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-red-100" /> Limited (1-5 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-gray-100" /> Full
        </span>
      </div>

      {/* Season legend — only shown when season data is available */}
      {uniqueSeasons.length > 0 && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
          {uniqueSeasons.map((s) => (
            <span key={s.name} className="flex items-center gap-1">
              <span
                className={`h-3 w-3 rounded border-t-2 ${
                  s.type === "WINTER" ? "border-blue-400" : "border-amber-400"
                }`}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
