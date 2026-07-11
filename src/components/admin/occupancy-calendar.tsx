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

export type CalendarTone = "red" | "amber" | "orange" | "green" | "violet";

// How prominently an overlay paints its cell. "fill" (default) is the original
// solid tint; "ring" draws a low-emphasis outline over a white cell so a covered
// night with no guests reads as quiet history rather than an active state.
export type CalendarOverlayEmphasis = "fill" | "ring";

export type CalendarOverlayValue = {
  tone: CalendarTone;
  label: string;
  emphasis?: CalendarOverlayEmphasis;
};

// Static class table so Tailwind sees every class literally (no dynamic class
// construction, which its JIT would prune). Consumers pass a tone; the calendar
// never builds these strings at runtime. `ringCell` is the low-emphasis variant
// used when an overlay sets emphasis: "ring".
//
// "Restrained Alpine" (epic #1800, #1815): each tone now renders on the shared
// dark-adapting semantic tokens (#1801/#1804 success/warning/info/danger + the
// neutral muted pair) instead of hardcoded Tailwind hues, so overlays adapt in
// dark mode. The keys stay the original COLOUR NAMES to preserve the tone-string
// API that callers (roster + hut-leaders) already pass — so a key's name no
// longer implies its rendered hue (e.g. `orange` renders `info`, `violet`
// renders neutral). Meaning is always carried by the overlay's text label too,
// never colour alone. Roster severity order (needs-roster > suggested >
// needs-attention > confirmed) maps onto danger > warning > info > success.
const CALENDAR_TONE_CLASSES: Record<
  CalendarTone,
  { cell: string; ringCell: string; badge: string }
> = {
  red: {
    cell: "border-danger/40 bg-danger-muted text-foreground hover:bg-danger-muted/70",
    ringCell: "ring-1 ring-inset ring-danger/50 bg-card text-foreground hover:bg-danger-muted/40",
    badge: "bg-danger-muted text-danger",
  },
  amber: {
    cell: "border-warning/40 bg-warning-muted text-foreground hover:bg-warning-muted/70",
    ringCell: "ring-1 ring-inset ring-warning/50 bg-card text-foreground hover:bg-warning-muted/40",
    badge: "bg-warning-muted text-warning",
  },
  orange: {
    cell: "border-info/40 bg-info-muted text-foreground hover:bg-info-muted/70",
    ringCell: "ring-1 ring-inset ring-info/50 bg-card text-foreground hover:bg-info-muted/40",
    badge: "bg-info-muted text-info",
  },
  green: {
    cell: "border-success/40 bg-success-muted text-foreground hover:bg-success-muted/70",
    ringCell: "ring-1 ring-inset ring-success/50 bg-card text-foreground hover:bg-success-muted/40",
    badge: "bg-success-muted text-success",
  },
  violet: {
    cell: "border-border bg-muted text-foreground hover:bg-muted/70",
    ringCell: "ring-1 ring-inset ring-border bg-card text-foreground hover:bg-muted/60",
    badge: "bg-muted text-foreground",
  },
};

type OccupancyCalendarProps = {
  mode: OccupancyCalendarMode;
  selectedStartDate?: string;
  selectedEndDate?: string;
  onSelectionChange: (selection: { startDate: string; endDate: string }) => void;
  // Optional per-date colour overlay (e.g. roster status). Backwards compatible:
  // consumers that pass none behave exactly as before. An entry may set
  // emphasis: "ring" to paint a low-emphasis outline instead of a solid fill.
  overlayByDate?: Record<string, CalendarOverlayValue>;
  overlayLegend?: Array<{ tone: CalendarTone; label: string }>;
  // Fires with the visible month key (YYYY-MM) on mount and every navigation, so
  // a parent can lazily load overlay data for the month in view.
  onVisibleMonthChange?: (month: string) => void;
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
  overlayByDate,
  overlayLegend,
  onVisibleMonthChange,
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
    onVisibleMonthChange?.(visibleMonthKey);
  }, [visibleMonthKey, onVisibleMonthChange]);

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
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
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
          <div className="min-w-36 text-center text-sm font-semibold text-foreground">
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
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarDays className="h-4 w-4" />
          {loadingMonthKeys.includes(visibleMonthKey)
            ? "Loading occupancy..."
            : "Operational bookings only"}
        </div>
      </div>

      {loadError && (
        <div className="border-b border-danger/30 bg-danger-muted px-3 py-2 text-sm text-danger">
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-7 border-b border-border">
        {DAY_LABELS.map((label) => (
          <div key={label} className="px-1 py-2 text-center text-xs font-medium text-muted-foreground">
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {Array.from({ length: startOffset }).map((_, index) => (
          <div key={`empty-${index}`} className="min-h-16 border-b border-r border-border bg-muted" />
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
          const overlay = overlayByDate?.[dateString];
          const selectionClass =
            isSelectedStart || isSelectedEnd
              ? "border-brand-gold bg-brand-gold text-brand-charcoal"
              : isInRange
                ? "border-brand-gold/40 bg-brand-gold/25 text-foreground"
                : overlay
                  ? overlay.emphasis === "ring"
                    ? CALENDAR_TONE_CLASSES[overlay.tone].ringCell
                    : CALENDAR_TONE_CLASSES[overlay.tone].cell
                  : hasGuests
                    ? "border-brand-gold/25 bg-brand-gold/10 text-foreground hover:bg-brand-gold/20"
                    : "border-border bg-card text-foreground hover:bg-muted";
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
              aria-label={`${formatDisplayDate(dateString)}, ${guestLabel}${isPast ? ", past date" : ""}${overlay ? `, ${overlay.label}` : ""}`}
              // Stable hooks for tests/tooling so overlay assertions target the
              // tone + emphasis rather than the token class strings, which the
              // "Restrained Alpine" restyle may re-tint.
              data-overlay-tone={overlay?.tone}
              data-overlay-emphasis={overlay ? (overlay.emphasis ?? "fill") : undefined}
              className={`min-h-16 border-b border-r p-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground ${selectionClass}`}
            >
              <span className="block text-sm font-semibold leading-none">{day}</span>
              {hasGuests && (
                <span className={`mt-2 inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${
                  isSelectedStart || isSelectedEnd
                    ? "bg-brand-charcoal/15 text-brand-charcoal"
                    : "bg-brand-gold/20 text-brand-charcoal dark:bg-brand-gold/15 dark:text-brand-gold"
                }`}>
                  <Users className="mr-1 h-3 w-3" />
                  {night?.guestCount}
                </span>
              )}
              {overlay && (
                <span
                  className={`mt-1 block truncate rounded px-1 py-0.5 text-[10px] font-medium leading-tight ${CALENDAR_TONE_CLASSES[overlay.tone].badge}`}
                >
                  {overlay.label}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="space-y-3 px-3 py-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="h-3 w-3 rounded bg-brand-gold/25 ring-1 ring-brand-gold/40" />
            Guests staying
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-3 w-3 rounded bg-brand-gold" />
            Selected {mode === "single" ? "date" : "range"}
          </span>
          {overlayLegend?.map((item) => (
            <span key={item.label} className="inline-flex items-center gap-1">
              <span className={"h-3 w-3 rounded " + CALENDAR_TONE_CLASSES[item.tone].badge} />
              {item.label}
            </span>
          ))}
        </div>

        <div className="rounded-md border border-border bg-muted p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Who&apos;s at the lodge</h3>
              <p className="text-xs text-muted-foreground">
                {selectedPanelRange
                  ? `${selectedPanelRange.startDate} to ${selectedPanelRange.endDate}`
                  : mode === "single"
                    ? "Select a date to see bookings."
                    : "Select a start and end date to see bookings."}
              </p>
            </div>
            {selectedPanelRange && (
              <Badge variant="outline" className="bg-card">
                {selectedRangeLoading
                  ? "Loading..."
                  : `${selectedGuestCount} guest-night${selectedGuestCount === 1 ? "" : "s"}`}
              </Badge>
            )}
          </div>

          {selectedRangeLoading ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Loading occupancy for this selection...
            </p>
          ) : selectedRangeLoadFailed ? (
            <p className="mt-3 text-sm text-danger">
              Occupancy could not be loaded for this selection.
            </p>
          ) : selectedPanelRange && selectedBookings.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No operational bookings in this selection.</p>
          ) : selectedPanelRange ? (
            <div className="mt-3 divide-y divide-border rounded-md border border-border bg-card">
              {selectedBookings.map((booking) => {
                const isSingleNight =
                  selectedPanelRange.startDate === selectedPanelRange.endDate;
                return (
                  <Link
                    key={booking.id}
                    href={`/bookings/${booking.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-muted"
                  >
                    <span>
                      <span className="font-medium text-foreground">{booking.ownerName}</span>
                      <span className="ml-2 text-xs text-muted-foreground">#{booking.reference}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
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
