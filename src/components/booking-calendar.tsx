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
  // Admin over-capacity create (#1767): when true, full future days stay
  // selectable — over-capacity is warn-and-confirm at submit. Default false
  // keeps the member flow byte-identical (full days disabled).
  allowFullDates?: boolean;
}

// Retroactive bookings may reach at most this many days into the past. Kept in
// sync with RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS on the server (#1695).
const RETROACTIVE_LOOKBACK_DAYS = 365;

export function BookingCalendar({ onDateSelect, selectedCheckIn, selectedCheckOut, lodgeId, allowPastDates = false, allowFullDates = false }: BookingCalendarProps) {
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

    let classes = "relative flex h-12 w-10 flex-col items-center justify-center rounded-md text-sm font-medium transition-colors ";

    // Season top-border indicator
    if (season?.type === "WINTER") {
      classes += "border-t-2 border-info-7 ";
    } else if (season?.type === "SUMMER") {
      classes += "border-t-2 border-warning-7 ";
    }

    // Availability heat, token-driven so it dark-adapts (epic #1800). The
    // per-night free-bed count text below carries the same information, so colour
    // is never the only signal. The thresholds and branch order are byte-identical
    // to the previous green/amber/red/grey treatment — only the classes change.
    if (isPast) {
      classes += "text-muted-foreground cursor-not-allowed ";
    } else if (isRetroPast) {
      // Muted-but-clickable tint for a past date open to retroactive booking:
      // distinct from the availability heat and the full tint.
      classes += "bg-muted text-muted-foreground italic hover:shadow-sm cursor-pointer ";
    } else if (available <= 0) {
      // Full night (0 beds) -> danger token. Hard-disabled for members;
      // muted-but-clickable when the admin over-capacity flag allows selecting it
      // (#1767). The "Full" label rendered below states this without colour.
      classes += allowFullDates
        ? "bg-danger-muted text-danger italic hover:brightness-95 cursor-pointer "
        : "bg-danger-muted text-danger cursor-not-allowed ";
    } else if (available <= 5) {
      // Nearly full (1-5 beds) -> the information pair keeps this tier distinct
      // from the warning "filling" tier while remaining an explicit AA-gated
      // semantic endpoint in light and dark mode.
      classes += "bg-info-muted text-info hover:brightness-95 cursor-pointer ";
    } else if (available <= 15) {
      // Filling (6-15 beds) -> warning token.
      classes += "bg-warning-muted text-warning hover:brightness-95 cursor-pointer ";
    } else {
      // Plenty (>15 beds) -> success token.
      classes += "bg-success-muted text-success hover:brightness-95 cursor-pointer ";
    }

    // Selected range uses the brand-gold accent, deliberately distinct from the
    // availability heat so the two never read as the same signal.
    if (checkIn && date.getTime() === checkIn.getTime()) {
      classes += "!border-4 !border-double !border-brand-gold !bg-brand-gold !text-brand-charcoal ";
    } else if (checkOut && date.getTime() === checkOut.getTime()) {
      classes += "!border-4 !border-double !border-brand-gold !bg-brand-gold !text-brand-charcoal ";
    } else if (checkIn && checkOut && date > checkIn && date < checkOut) {
      classes += "!border-2 !border-dashed !border-brand-gold !bg-muted !text-foreground ";
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

      <div aria-live="polite" className="text-sm text-muted-foreground">
        {selecting === "checkIn" ? "Select check-in date" : "Select check-out date"}
      </div>

      <div className="grid grid-cols-7 justify-items-center gap-1 text-center">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="w-10 py-2 text-xs font-medium text-muted-foreground">
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
          const season = seasons[dateStr];
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
          // Convey the visual selection highlight to screen readers, which
          // otherwise only hear the availability label and can't tell which day
          // is chosen.
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
          const seasonSuffix = season?.name ? `, ${season.name} season` : "";
          const dayLabel =
            (isPast
              ? `${dateLabel}, unavailable`
              : available <= 0
                ? `${dateLabel}, full${allowFullDates ? " — selectable for over-capacity booking" : ""}`
                : `${dateLabel}, ${available} of ${lodgeCapacity} beds free`) +
            retroSuffix +
            seasonSuffix +
            selectionSuffix;

          return (
            <button
              key={day}
              onClick={() => handleDayClick(day)}
              className={getDayClass(day, available, isPast, isRetroPast, dateStr)}
              // Full nights stay clickable under the retroactive or admin
              // over-capacity flags — over-capacity is warn-and-confirm at
              // submit, not a hard block.
              disabled={isPast || (available <= 0 && !allowPastDates && !allowFullDates)}
              aria-label={dayLabel}
              aria-pressed={isCheckIn || isCheckOut || inRange}
            >
              <span aria-hidden="true" className="leading-none">{day}</span>
              {season ? (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-0.5 text-[0.5rem] font-bold uppercase leading-none"
                  title={`${season.name} season`}
                >
                  {season.type === "WINTER" ? "W" : "S"}
                </span>
              ) : null}
              {!isPast &&
                (isCheckIn || isCheckOut || inRange ? (
                  <span
                    aria-hidden="true"
                    className="mt-0.5 text-[0.625rem] font-semibold uppercase leading-none tracking-wide"
                  >
                    {isCheckIn ? "In" : isCheckOut ? "Out" : "Stay"}
                  </span>
                ) : available <= 0 ? (
                  // "Full" states availability without relying on colour; the
                  // aria-label already announces "full" for screen readers.
                  <span
                    aria-hidden="true"
                    className="mt-0.5 text-[0.625rem] font-semibold uppercase leading-none tracking-wide"
                  >
                    Full
                  </span>
                ) : (
                  <span aria-hidden="true" className="text-xs leading-none mt-0.5">
                    {available}
                  </span>
                ))}
            </button>
          );
        })}
      </div>

      {/* Availability legend — swatches mirror the token-driven heat above */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-success-muted" /> Available (&gt;15 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-warning-muted" /> Filling (6-15 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-info-muted" /> Nearly full (1-5 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-danger-muted" /> Full
        </span>
      </div>

      {/* Season legend — only shown when season data is available */}
      {uniqueSeasons.length > 0 && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          {uniqueSeasons.map((s) => (
            <span key={s.name} className="flex items-center gap-1">
              <span
                className={`h-3 w-3 rounded border-t-2 ${
                  s.type === "WINTER" ? "border-info-7" : "border-warning-7"
                }`}
              />
              <span aria-hidden className="font-semibold">
                {s.type === "WINTER" ? "W" : "S"}
              </span>
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
