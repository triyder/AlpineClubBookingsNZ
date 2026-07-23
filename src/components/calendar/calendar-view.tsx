"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import {
  addMonths,
  formatMonthTitle,
  groupEventsByDay,
  monthGridRange,
  startOfMonth,
} from "@/lib/calendar-client";
import { MonthCalendar } from "./month-calendar";
import { EventDialog } from "./event-dialog";

interface CalendarViewProps {
  /** Whether the current member may add/edit/delete (committee or lodge admin). */
  canManage: boolean;
  /**
   * When false, existing events are read-only even for a manager — new events
   * can still be created. The member calendar (/calendar) passes false so it is
   * create-and-view only; /admin/calendar leaves it true for full editing.
   */
  allowEditExisting?: boolean;
}

export function CalendarView({
  canManage,
  allowEditExisting = true,
}: CalendarViewProps) {
  const canCreate = canManage;
  const canEditExisting = canManage && allowEditExisting;
  const [viewDate, setViewDate] = useState<Date>(() => startOfMonth(new Date()));
  const [events, setEvents] = useState<CalendarEventDTO[]>([]);
  const [loading, setLoading] = useState(true);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEventDTO | null>(
    null,
  );
  const [createDate, setCreateDate] = useState<string | null>(null);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    const { from, to } = monthGridRange(year, month);
    try {
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
      });
      const res = await fetch(`/api/calendar/events?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as { events: CalendarEventDTO[] };
        setEvents(data.events);
      }
    } catch {
      // Leave the previous events in place on a transient failure.
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const eventsByDay = useMemo(() => groupEventsByDay(events), [events]);

  function openCreate(dayKey: string | null) {
    setSelectedEvent(null);
    setCreateDate(dayKey);
    setDialogOpen(true);
  }

  function openEvent(event: CalendarEventDTO) {
    setSelectedEvent(event);
    setCreateDate(null);
    setDialogOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous month"
            onClick={() => setViewDate((d) => addMonths(d, -1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Next month"
            onClick={() => setViewDate((d) => addMonths(d, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setViewDate(startOfMonth(new Date()))}
          >
            Today
          </Button>
          <h2 className="ml-1 text-lg font-semibold text-foreground">
            {formatMonthTitle(year, month)}
          </h2>
          {loading && (
            <span className="text-xs text-muted-foreground">Loading…</span>
          )}
        </div>

        {canCreate && (
          <Button size="sm" onClick={() => openCreate(null)}>
            <Plus className="mr-2 h-4 w-4" />
            New event
          </Button>
        )}
      </div>

      <MonthCalendar
        year={year}
        month={month}
        eventsByDay={eventsByDay}
        canCreate={canCreate}
        onSelectEvent={openEvent}
        onSelectDay={(dayKey) => openCreate(dayKey)}
      />

      <EventDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        event={selectedEvent}
        initialDate={createDate}
        canCreate={canCreate}
        canEditExisting={canEditExisting}
        onSaved={fetchEvents}
      />
    </div>
  );
}
