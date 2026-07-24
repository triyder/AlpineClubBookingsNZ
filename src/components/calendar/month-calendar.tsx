"use client";

import { Video, Repeat, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import {
  buildMonthGrid,
  dateKey,
  formatDayKeyLong,
  formatEventTime,
  isSameMonth,
  isToday,
  weekdayLabels,
} from "@/lib/calendar-client";

interface MonthCalendarProps {
  year: number;
  month: number;
  eventsByDay: Map<string, CalendarEventDTO[]>;
  canCreate: boolean;
  onSelectEvent: (event: CalendarEventDTO) => void;
  /** Called with a YYYY-MM-DD key when an empty day is clicked (managers only). */
  onSelectDay: (dayKey: string) => void;
  /**
   * Called with a YYYY-MM-DD key to open the full day-detail list — every
   * viewer, triggered by the "+N more" overflow so the 4th event onward is
   * reachable.
   */
  onOpenDay: (dayKey: string) => void;
}

const MAX_CHIPS_PER_DAY = 3;

export function MonthCalendar({
  year,
  month,
  eventsByDay,
  canCreate,
  onSelectEvent,
  onSelectDay,
  onOpenDay,
}: MonthCalendarProps) {
  const days = buildMonthGrid(year, month);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-border bg-muted">
        {weekdayLabels().map((label) => (
          <div
            key={label}
            className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {label}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const key = dateKey(day);
          const inMonth = isSameMonth(day, year, month);
          const today = isToday(day);
          const dayEvents = eventsByDay.get(key) ?? [];
          const shown = dayEvents.slice(0, MAX_CHIPS_PER_DAY);
          const overflow = dayEvents.length - shown.length;
          const dayLabel = formatDayKeyLong(key);

          return (
            <div
              key={key}
              className={cn(
                "group min-h-[104px] border-b border-r border-border p-1.5 last:border-r-0 [&:nth-child(7n)]:border-r-0",
                inMonth ? "bg-background" : "bg-muted",
                canCreate && "cursor-pointer transition-colors hover:bg-accent",
              )}
              onClick={(e) => {
                // Mouse convenience only: a click on the empty cell (not a chip)
                // starts a new event. Keyboard users get the per-cell "Add event"
                // button below, so this div is never the sole path.
                if (canCreate && e.target === e.currentTarget) {
                  onSelectDay(key);
                }
              }}
            >
              <div className="mb-1 flex items-center justify-between">
                <span
                  className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium",
                    today && "bg-primary text-primary-foreground",
                    !today && inMonth && "text-foreground",
                    !today && !inMonth && "text-muted-foreground",
                  )}
                >
                  {/* Screen readers announce the full date; sighted users see the
                      day number. */}
                  <span className="sr-only">{dayLabel}</span>
                  <span aria-hidden>{day.getDate()}</span>
                </span>
                {canCreate && (
                  <button
                    type="button"
                    aria-label={`Add event on ${dayLabel}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectDay(key);
                    }}
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>

              <div className="space-y-1">
                {shown.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectEvent(event);
                    }}
                    className={cn(
                      "flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-left text-xs transition-colors",
                      event.isMeeting
                        ? "bg-primary text-primary-foreground hover:opacity-90"
                        : "bg-accent text-accent-foreground hover:opacity-90",
                    )}
                    title={event.title}
                  >
                    {event.isMeeting && (
                      <Video aria-hidden className="h-3 w-3 shrink-0" />
                    )}
                    {event.seriesId && !event.isMeeting && (
                      <Repeat aria-hidden className="h-3 w-3 shrink-0 opacity-70" />
                    )}
                    <span className="truncate">
                      {!event.allDay && (
                        <span className="mr-1 tabular-nums opacity-70">
                          {formatEventTime(event)}
                        </span>
                      )}
                      {event.title}
                    </span>
                  </button>
                ))}
                {overflow > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDay(key);
                    }}
                    className="rounded px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                    aria-label={`Show all ${dayEvents.length} events on this day`}
                  >
                    +{overflow} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
