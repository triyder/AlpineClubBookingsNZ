"use client";

import { useEffect, useState } from "react";
import { Video, MapPin, Trash2, ExternalLink, Repeat } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import type {
  CalendarEditScope,
  CalendarEventDTO,
} from "@/lib/calendar-events";
import {
  formatEventDateLong,
  formatTime,
  isoFromDateTimeInputs,
  shouldIncludeRecurrence,
  toDateInputValue,
  toTimeInputValue,
} from "@/lib/calendar-client";
import {
  describeRecurrence,
  recurrenceOptionsForDate,
  recurrenceUnitLabel,
  type CalendarRecurrenceFrequency,
  type RecurrenceEndMode,
} from "@/lib/calendar-recurrence";

type RepeatValue = CalendarRecurrenceFrequency | "NONE";

interface EventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The event being edited/viewed, or null when creating. */
  event: CalendarEventDTO | null;
  /** Pre-selected day (YYYY-MM-DD) when creating from a day cell. */
  initialDate: string | null;
  /** Whether the current member may create NEW events. */
  canCreate: boolean;
  /**
   * Whether the current member may MANAGE the calendar (an active committee
   * member or a lodge admin). Gates the read-only "Join meeting" button:
   * ordinary members see event details but not the meeting link — only
   * committee members / admins can join. See src/lib/calendar-access.ts.
   */
  canManage: boolean;
  /**
   * Whether EXISTING events open editable (Save/Delete). When false, an existing
   * event shows the read-only detail view even for a manager — the member
   * calendar creates but does not edit; /admin/calendar keeps full editing.
   */
  canEditExisting: boolean;
  /** Called after a successful create/update/delete so the caller can refetch. */
  onSaved: () => void;
}

function todayDateValue(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const selectClasses =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export function EventDialog({
  open,
  onOpenChange,
  event,
  initialDate,
  canCreate,
  canManage,
  canEditExisting,
  onSaved,
}: EventDialogProps) {
  const isEdit = event !== null;
  const isSeriesEvent = Boolean(event?.seriesId);

  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [location, setLocation] = useState("");
  const [details, setDetails] = useState("");
  const [isMeeting, setIsMeeting] = useState(false);

  // Recurrence
  const [repeat, setRepeat] = useState<RepeatValue>("NONE");
  const [interval, setIntervalValue] = useState(1);
  const [endMode, setEndMode] = useState<RecurrenceEndMode>("never");
  const [until, setUntil] = useState("");
  const [count, setCount] = useState(10);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When editing/deleting an occurrence of a series, ask which occurrences the
  // action applies to before committing.
  const [scopePrompt, setScopePrompt] = useState<"save" | "delete" | null>(null);
  // Confirm dialogs (replacing native window.confirm): deleting a single event,
  // and discarding unsaved edits when closing the form.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  // Serialised baseline of the form as last (re)opened, to detect dirty edits.
  const [baseline, setBaseline] = useState<string>("");

  // Reset the form whenever the dialog opens for a different event/day.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    setScopePrompt(null);
    setConfirmDelete(false);
    setDiscardPrompt(false);

    const next = event
      ? {
          title: event.title,
          allDay: event.allDay,
          date: toDateInputValue(event.startsAt),
          startTime: event.allDay ? "" : toTimeInputValue(event.startsAt),
          endTime: event.endsAt ? toTimeInputValue(event.endsAt) : "",
          location: event.location ?? "",
          details: event.details ?? "",
          isMeeting: event.isMeeting,
          repeat: (event.recurrence?.frequency ?? "NONE") as RepeatValue,
          interval: event.recurrence?.interval ?? 1,
          endMode: (event.recurrence?.endMode ?? "never") as RecurrenceEndMode,
          until: event.recurrence?.until
            ? toDateInputValue(event.recurrence.until)
            : "",
          count: event.recurrence?.count ?? 10,
        }
      : {
          title: "",
          allDay: false,
          date: initialDate ?? todayDateValue(),
          startTime: "09:00",
          endTime: "",
          location: "",
          details: "",
          isMeeting: false,
          repeat: "NONE" as RepeatValue,
          interval: 1,
          endMode: "never" as RecurrenceEndMode,
          until: "",
          count: 10,
        };

    setTitle(next.title);
    setAllDay(next.allDay);
    setDate(next.date);
    setStartTime(next.startTime);
    setEndTime(next.endTime);
    setLocation(next.location);
    setDetails(next.details);
    setIsMeeting(next.isMeeting);
    setRepeat(next.repeat);
    setIntervalValue(next.interval);
    setEndMode(next.endMode);
    setUntil(next.until);
    setCount(next.count);
    // Record the just-loaded values as the clean baseline for dirty detection.
    setBaseline(JSON.stringify(next));
  }, [open, event, initialDate]);

  // Read-only detail view: shown to ordinary members, and to managers on the
  // member calendar (where existing events are not editable). A meeting shows a
  // "Join meeting" button only to managers (committee members / admins) — an
  // ordinary member sees the event details but cannot join the meeting.
  if (event && !canEditExisting) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {event.isMeeting && (
                <Video aria-hidden className="h-4 w-4 text-primary" />
              )}
              {event.title}
            </DialogTitle>
            <DialogDescription>
              {formatEventDateLong(event)}
              {!event.allDay && (
                <>
                  {" · "}
                  {formatTime(event.startsAt)}
                  {event.endsAt ? ` – ${formatTime(event.endsAt)}` : ""}
                </>
              )}
              {event.allDay && " · All day"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {event.recurrence && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Repeat aria-hidden className="h-4 w-4" />
                {describeRecurrence(
                  {
                    frequency: event.recurrence.frequency,
                    interval: event.recurrence.interval,
                    endMode: event.recurrence.endMode,
                    until: event.recurrence.until,
                    count: event.recurrence.count,
                  },
                  new Date(event.startsAt),
                )}
              </p>
            )}
            {event.location && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <MapPin aria-hidden className="h-4 w-4" />
                {event.location}
              </p>
            )}
            {event.details && (
              <p className="whitespace-pre-wrap text-foreground">
                {event.details}
              </p>
            )}
            {!event.location && !event.details && !event.recurrence && (
              <p className="text-muted-foreground">No further details.</p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            {canManage && event.isMeeting && event.meetingUrl ? (
              <Button asChild>
                <a
                  href={event.meetingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Video aria-hidden className="mr-2 h-4 w-4" />
                  Join meeting
                </a>
              </Button>
            ) : (
              <span />
            )}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Creating requires create permission. The New-event affordances are hidden
  // without it, so this is a defensive guard against an unreachable state.
  if (!event && !canCreate) return null;

  // Dirty detection: compare the live form to the baseline captured on open, so
  // closing a form with unsaved edits can prompt before discarding.
  const currentSnapshot = JSON.stringify({
    title,
    allDay,
    date,
    startTime,
    endTime,
    location,
    details,
    isMeeting,
    repeat,
    interval,
    endMode,
    until,
    count,
  });
  const isDirty = currentSnapshot !== baseline;

  // Guarded close: prompt before discarding unsaved edits; a clean form (or an
  // in-flight save) closes straight away.
  function requestClose() {
    if (saving) return;
    if (isDirty) {
      setDiscardPrompt(true);
      return;
    }
    onOpenChange(false);
  }

  // Labels for the Repeat picker follow the currently-selected date.
  const anchorDate = date ? new Date(`${date}T00:00`) : new Date();
  const repeatOptions = recurrenceOptionsForDate(anchorDate);

  async function submit(scope: CalendarEditScope) {
    setError(null);

    if (!title.trim()) {
      setError("Please enter a title.");
      setScopePrompt(null);
      return;
    }
    if (!date) {
      setError("Please choose a date.");
      setScopePrompt(null);
      return;
    }

    const startsAt = isoFromDateTimeInputs(
      date,
      allDay ? undefined : startTime || "00:00",
    );
    if (!startsAt) {
      setError("The date or start time is invalid.");
      setScopePrompt(null);
      return;
    }
    const endsAt =
      !allDay && endTime ? isoFromDateTimeInputs(date, endTime) : null;

    // Send the recurrence rule EXCEPT when editing a single occurrence of an
    // existing series — that path changes only this occurrence, never the
    // pattern. On create, and when converting a standalone event to recurring,
    // and on a whole-series edit, the rule is included (see
    // shouldIncludeRecurrence).
    const recurrence =
      repeat === "NONE" ||
      !shouldIncludeRecurrence({ repeat, isEdit, isSeriesEvent, scope })
        ? null
        : {
            frequency: repeat,
            interval: Math.max(1, interval || 1),
            endMode,
            until:
              endMode === "until"
                ? isoFromDateTimeInputs(until, "12:00")
                : null,
            count: endMode === "count" ? Math.max(1, count || 1) : null,
          };

    if (recurrence && endMode === "until" && !until) {
      setError("Please choose an end date for the recurrence.");
      setScopePrompt(null);
      return;
    }

    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        location: location.trim() || null,
        details: details.trim() || null,
        allDay,
        startsAt,
        endsAt,
        isMeeting,
        recurrence,
        scope,
      };
      const res = await fetch(
        isEdit ? `/api/calendar/events/${event.id}` : "/api/calendar/events",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? "Could not save the event. Please try again.");
        setSaving(false);
        setScopePrompt(null);
        return;
      }
      onSaved();
      onOpenChange(false);
    } catch {
      setError("Could not save the event. Please try again.");
      setSaving(false);
      setScopePrompt(null);
    }
  }

  function handleSaveClick() {
    if (isSeriesEvent) {
      setScopePrompt("save");
      return;
    }
    submit("single");
  }

  async function performDelete(scope: CalendarEditScope) {
    if (!event) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/calendar/events/${event.id}?scope=${scope}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setError("Could not delete the event. Please try again.");
        setSaving(false);
        setScopePrompt(null);
        setConfirmDelete(false);
        return;
      }
      onSaved();
      onOpenChange(false);
    } catch {
      setError("Could not delete the event. Please try again.");
      setSaving(false);
      setScopePrompt(null);
      setConfirmDelete(false);
    }
  }

  function handleDeleteClick() {
    if (!event) return;
    if (isSeriesEvent) {
      setScopePrompt("delete");
      return;
    }
    // In-app confirm dialog (not native window.confirm), matching the series
    // scope chooser.
    setConfirmDelete(true);
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit event" : "New event"}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? "Update the details for this club event."
                : "Add an event to the club calendar."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="event-title">Title</Label>
              <Input
                id="event-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Committee meeting"
                maxLength={200}
              />
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="event-all-day"
                checked={allDay}
                onCheckedChange={(checked) => setAllDay(checked)}
              />
              <Label htmlFor="event-all-day" className="cursor-pointer">
                All-day event
              </Label>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-1">
                <Label htmlFor="event-date">Date</Label>
                <Input
                  id="event-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              {!allDay && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="event-start">Start time</Label>
                    <Input
                      id="event-start"
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="event-end">End time</Label>
                    <Input
                      id="event-end"
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Recurrence */}
            <div className="space-y-1.5">
              <Label htmlFor="event-repeat" className="flex items-center gap-1.5">
                <Repeat aria-hidden className="h-4 w-4 text-muted-foreground" />
                Repeat
              </Label>
              <select
                id="event-repeat"
                className={selectClasses}
                value={repeat}
                onChange={(e) => setRepeat(e.target.value as RepeatValue)}
              >
                {repeatOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {isEdit && isSeriesEvent && (
                <p className="text-xs text-muted-foreground">
                  Changing how this repeats applies when you choose “All events”
                  on save.
                </p>
              )}
            </div>

            {repeat !== "NONE" && (
              <div className="grid grid-cols-1 gap-4 rounded-md border border-border bg-muted p-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="event-interval">Repeat every</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="event-interval"
                      type="number"
                      min={1}
                      max={52}
                      value={interval}
                      onChange={(e) =>
                        setIntervalValue(Number(e.target.value) || 1)
                      }
                      className="w-20"
                    />
                    <span className="text-sm text-muted-foreground">
                      {recurrenceUnitLabel(repeat)}
                      {interval === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="event-end-mode">Ends</Label>
                  <select
                    id="event-end-mode"
                    className={selectClasses}
                    value={endMode}
                    onChange={(e) =>
                      setEndMode(e.target.value as RecurrenceEndMode)
                    }
                  >
                    <option value="never">Never</option>
                    <option value="until">On date</option>
                    <option value="count">After N times</option>
                  </select>
                </div>

                {endMode === "until" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="event-until">End date</Label>
                    <Input
                      id="event-until"
                      type="date"
                      value={until}
                      onChange={(e) => setUntil(e.target.value)}
                    />
                  </div>
                )}
                {endMode === "count" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="event-count">Occurrences</Label>
                    <Input
                      id="event-count"
                      type="number"
                      min={1}
                      max={366}
                      value={count}
                      onChange={(e) => setCount(Number(e.target.value) || 1)}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="event-location">Location (optional)</Label>
              <Input
                id="event-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Clubrooms / online"
                maxLength={200}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="event-details">Details (optional)</Label>
              <Textarea
                id="event-details"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="Agenda, notes, links…"
                rows={3}
                maxLength={5000}
              />
            </div>

            <div className="flex items-center gap-2 rounded-md border border-border bg-muted p-3">
              <Checkbox
                id="event-meeting"
                checked={isMeeting}
                onCheckedChange={(checked) => setIsMeeting(checked)}
              />
              <Label htmlFor="event-meeting" className="cursor-pointer">
                <span className="flex items-center gap-1.5 font-medium">
                  <Video aria-hidden className="h-4 w-4 text-primary" />
                  Video meeting (MiroTalk)
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  Creates a meeting link committee members can join.
                </span>
              </Label>
            </div>

            {isEdit && event?.isMeeting && event.meetingUrl && (
              <a
                href={event.meetingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
              >
                <ExternalLink aria-hidden className="h-4 w-4" />
                Open meeting link
              </a>
            )}

            {error && (
              <p className="text-sm font-medium text-destructive">{error}</p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {isEdit ? (
              <Button
                type="button"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={handleDeleteClick}
                disabled={saving}
              >
                <Trash2 aria-hidden className="mr-2 h-4 w-4" />
                Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={requestClose}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="button" onClick={handleSaveClick} disabled={saving}>
                {saving ? "Saving…" : isEdit ? "Save changes" : "Create event"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Scope chooser for recurring-event edits/deletes. */}
      <Dialog
        open={scopePrompt !== null}
        onOpenChange={(v) => {
          if (!v) setScopePrompt(null);
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {scopePrompt === "delete" ? "Delete recurring event" : "Edit recurring event"}
            </DialogTitle>
            <DialogDescription>
              This event is part of a series. Apply to just this occurrence, or
              the whole series?
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() =>
                scopePrompt === "delete"
                  ? performDelete("single")
                  : submit("single")
              }
            >
              This event only
            </Button>
            <Button
              variant={scopePrompt === "delete" ? "destructive" : "default"}
              disabled={saving}
              onClick={() =>
                scopePrompt === "delete"
                  ? performDelete("series")
                  : submit("series")
              }
            >
              All events in the series
            </Button>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setScopePrompt(null)}
            >
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Single-event delete confirmation (in-app, replacing window.confirm). */}
      <Dialog
        open={confirmDelete}
        onOpenChange={(v) => {
          if (!v) setConfirmDelete(false);
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete event</DialogTitle>
            <DialogDescription>
              Delete “{event?.title}”? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={() => performDelete("single")}
            >
              {saving ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved-changes guard when closing the form. */}
      <Dialog
        open={discardPrompt}
        onOpenChange={(v) => {
          if (!v) setDiscardPrompt(false);
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              You have unsaved changes to this event. Discard them?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDiscardPrompt(false)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDiscardPrompt(false);
                onOpenChange(false);
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
