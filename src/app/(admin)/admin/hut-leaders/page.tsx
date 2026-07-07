"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trash2, UserCheck, CalendarDays, KeyRound } from "lucide-react";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { calculateOverlapDays } from "@/lib/hut-leader-overlap";
import { LodgeSelect, useLodgeOptions } from "@/components/lodge-select";
import { useClubIdentity } from "@/components/club-identity-provider";
import type {
  CalendarOverlayValue,
  CalendarTone,
} from "@/components/admin/occupancy-calendar";
import type { PickedMember } from "@/components/admin/member-picker";
import {
  AssignmentForm,
  type AssignmentSummary,
  type AssignmentTarget,
  type EligibleMember,
} from "./_components/assignment-form";

interface HutLeaderAssignment {
  id: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  lodgeId: string | null;
  lodgeName: string | null;
}

interface UnassignedDate {
  date: string;
  bookingCount: number;
  guestCount: number;
}

function monthKeyForDate(date: Date) {
  return formatDateOnly(date).slice(0, 7);
}

// Compute the last inclusive day of a "YYYY-MM" month.
function monthBounds(monthKey: string) {
  const start = parseDateOnly(`${monthKey}-01`);
  const [year, month] = monthKey.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endExclusive = parseDateOnly(
    `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`,
  );
  return { start, end: addDaysDateOnly(endExclusive, -1) };
}

// Short calendar-badge label for a covered night: the surname, or initials when
// the surname is long, so a custodian's multi-month block reads as a band.
function shortLeaderLabel(memberName: string) {
  const parts = memberName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return memberName;
  const surname = parts[parts.length - 1];
  if (surname.length > 10) {
    return parts.map((p) => p[0]?.toUpperCase() ?? "").join("");
  }
  return surname;
}

export default function HutLeadersPage() {
  const { hutLeaderLabel } = useClubIdentity();
  const [assignments, setAssignments] = useState<HutLeaderAssignment[]>([]);
  const [eligibleMembers, setEligibleMembers] = useState<EligibleMember[]>([]);
  const [unassignedDates, setUnassignedDates] = useState<UnassignedDate[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [resettingPinId, setResettingPinId] = useState<string | null>(null);
  const [pinMessage, setPinMessage] = useState<{
    memberName: string;
    pin: string;
    emailSent: boolean;
  } | null>(null);

  const [selection, setSelection] = useState({ startDate: "", endDate: "" });
  const [target, setTarget] = useState<AssignmentTarget | null>(null);
  const [error, setError] = useState<{ message: string; memberId: string | null } | null>(null);
  // Lodge context for new assignments; LodgeSelect renders nothing (and
  // reports the sole lodge) while fewer than two lodges exist (ADR-002).
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin");
  const [lodgeId, setLodgeId] = useState<string | null>(null);
  const showLodgeColumn = lodges.length > 1;

  const [visibleMonthKey, setVisibleMonthKey] = useState(() =>
    monthKeyForDate(getTodayDateOnly()),
  );
  // Windowed "needs a leader" dates and occupied nights, keyed by visible month.
  const [redDatesByMonth, setRedDatesByMonth] = useState<Record<string, string[]>>({});
  const [guestNightsByMonth, setGuestNightsByMonth] = useState<
    Record<string, Set<string>>
  >({});

  const fetchAssignments = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/hut-leaders");
      if (res.ok) {
        const data = await res.json();
        setAssignments(data.assignments);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Default lookahead window — feeds the amber "Upcoming Dates Without…" card.
  // Intentionally the un-windowed variant so that card is byte-for-byte unchanged.
  const fetchUnassignedDates = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/hut-leaders/unassigned-dates");
      if (res.ok) {
        const data = await res.json();
        setUnassignedDates(data.unassignedDates);
      }
    } catch {
      // ignore
    }
  }, []);

  // Per-month overlay data: red (needs-leader) nights via the windowed variant,
  // and occupied nights (for violet fill-vs-ring emphasis) via the occupancy API.
  const refreshOverlay = useCallback(async (monthKey: string) => {
    try {
      const res = await fetch(
        `/api/admin/hut-leaders/unassigned-dates?month=${monthKey}`,
      );
      if (res.ok) {
        const data: { unassignedDates: UnassignedDate[] } = await res.json();
        setRedDatesByMonth((prev) => ({
          ...prev,
          [monthKey]: data.unassignedDates.map((d) => d.date),
        }));
      }
    } catch {
      // non-essential overlay
    }
    try {
      const res = await fetch(`/api/admin/occupancy?month=${monthKey}`);
      if (res.ok) {
        const data: { nights?: Array<{ date: string; guestCount: number }> } =
          await res.json();
        const guestNights = new Set(
          (data.nights ?? [])
            .filter((n) => n.guestCount > 0)
            .map((n) => n.date),
        );
        setGuestNightsByMonth((prev) => ({ ...prev, [monthKey]: guestNights }));
      }
    } catch {
      // non-essential overlay
    }
  }, []);

  const handleVisibleMonthChange = useCallback(
    (monthKey: string) => {
      setVisibleMonthKey(monthKey);
      fetchAssignments();
      refreshOverlay(monthKey);
    },
    [fetchAssignments, refreshOverlay],
  );

  useEffect(() => {
    fetchAssignments();
    fetchUnassignedDates();
  }, [fetchAssignments, fetchUnassignedDates]);

  // Fetch eligible members whenever the picked range changes.
  useEffect(() => {
    if (
      !selection.startDate ||
      !selection.endDate ||
      selection.startDate > selection.endDate
    ) {
      setEligibleMembers([]);
      return;
    }

    let cancelled = false;
    setLoadingMembers(true);

    fetch(
      `/api/admin/hut-leaders/eligible-members?startDate=${selection.startDate}&endDate=${selection.endDate}`,
    )
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (!cancelled) setEligibleMembers(data.members);
      })
      .catch(() => {
        if (!cancelled) setEligibleMembers([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingMembers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selection.startDate, selection.endDate]);

  // Step 1 — picking new nights always drops any selected target.
  function handlePickNights(next: { startDate: string; endDate: string }) {
    setSelection(next);
    setTarget(null);
  }

  // Step 2a — a suggestion adopts the member's conflict-free suggested range.
  function handleSelectEligible(member: EligibleMember) {
    setSelection({
      startDate: member.suggestedStartDate,
      endDate: member.suggestedEndDate,
    });
    setTarget({
      memberId: member.id,
      memberName: `${member.firstName} ${member.lastName}`,
    });
    setError(null);
  }

  // Step 2b — any member (including a no-booking custodian) keeps the picked range.
  function handleSelectAnyMember(member: PickedMember) {
    setTarget({
      memberId: member.id,
      memberName: `${member.firstName} ${member.lastName}`,
    });
    setError(null);
  }

  async function handleConfirm() {
    if (!target || !selection.startDate || !selection.endDate) return;
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/admin/hut-leaders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: target.memberId,
          startDate: selection.startDate,
          endDate: selection.endDate,
          ...(lodgeId ? { lodgeId } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError({
          message: data.error || "Failed to create",
          memberId: target.memberId,
        });
        return;
      }
      setSelection({ startDate: "", endDate: "" });
      setTarget(null);
      fetchAssignments();
      fetchUnassignedDates();
      refreshOverlay(visibleMonthKey);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(`Delete this ${hutLeaderLabel.toLowerCase()} assignment?`)) return;
    const res = await fetch(`/api/admin/hut-leaders/${id}`, { method: "DELETE" });
    if (res.ok) {
      fetchAssignments();
      fetchUnassignedDates();
      refreshOverlay(visibleMonthKey);
    }
  }

  async function handleResetPin(assignment: HutLeaderAssignment) {
    if (
      !confirm(
        `Generate a new kiosk PIN for ${assignment.memberName}? Their existing PIN will stop working.`,
      )
    ) {
      return;
    }

    setError(null);
    setPinMessage(null);
    setResettingPinId(assignment.id);
    try {
      const res = await fetch(`/api/admin/hut-leaders/${assignment.id}/pin`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError({ message: data.error || "Failed to reset PIN", memberId: null });
        return;
      }

      setPinMessage({
        memberName: assignment.memberName,
        pin: data.pin,
        emailSent: Boolean(data.emailSent),
      });
      fetchAssignments();
    } finally {
      setResettingPinId(null);
    }
  }

  function handleAssignForDate(date: string) {
    setSelection({ startDate: date, endDate: date });
    setTarget(null);
  }

  // ---- Calendar overlay (three layers: red needs-leader, violet covered) ----
  const overlayByDate = useMemo<Record<string, CalendarOverlayValue>>(() => {
    const overlay: Record<string, CalendarOverlayValue> = {};
    const { start: monthStart, end: monthEnd } = monthBounds(visibleMonthKey);
    const guestNights = guestNightsByMonth[visibleMonthKey];

    // Red first (violet overwrites on any collision so "covered" always wins).
    for (const date of redDatesByMonth[visibleMonthKey] ?? []) {
      overlay[date] = { tone: "red", label: "Needs leader" };
    }

    // Violet — covered nights, combining surnames on a shared handover day.
    const surnamesByDate = new Map<string, Set<string>>();
    for (const a of assignments) {
      const aStart = parseDateOnly(a.startDate);
      const aEnd = parseDateOnly(a.endDate);
      const from = aStart.getTime() > monthStart.getTime() ? aStart : monthStart;
      const to = aEnd.getTime() < monthEnd.getTime() ? aEnd : monthEnd;
      const surname = shortLeaderLabel(a.memberName);
      for (
        let day = from;
        day.getTime() <= to.getTime();
        day = addDaysDateOnly(day, 1)
      ) {
        const ds = formatDateOnly(day);
        const set = surnamesByDate.get(ds) ?? new Set<string>();
        set.add(surname);
        surnamesByDate.set(ds, set);
      }
    }
    for (const [ds, surnames] of surnamesByDate) {
      overlay[ds] = {
        tone: "violet",
        label: [...surnames].join(" / "),
        emphasis: guestNights?.has(ds) ? "fill" : "ring",
      };
    }

    return overlay;
  }, [assignments, redDatesByMonth, guestNightsByMonth, visibleMonthKey]);

  const overlayLegend = useMemo<Array<{ tone: CalendarTone; label: string }>>(
    () => [
      { tone: "violet", label: `Has a ${hutLeaderLabel}` },
      { tone: "red", label: `Needs a ${hutLeaderLabel}` },
    ],
    [hutLeaderLabel],
  );

  // ---- Step-3 summary + client-side conflict preview -----------------------
  const summary = useMemo<AssignmentSummary | null>(() => {
    if (!target || !selection.startDate || !selection.endDate) return null;
    if (selection.startDate > selection.endDate) return null;

    const start = parseDateOnly(selection.startDate);
    const end = parseDateOnly(selection.endDate);
    const nights =
      Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;

    // Fills: how many currently-red nights this range would cover. Uses every
    // month of red data we have loaded so a cross-month range still counts.
    const redSet = new Set(Object.values(redDatesByMonth).flat());
    let fills = 0;
    for (
      let day = start;
      day.getTime() <= end.getTime();
      day = addDaysDateOnly(day, 1)
    ) {
      if (redSet.has(formatDateOnly(day))) fills++;
    }

    // Conflicts: same calculateOverlapDays the POST route uses (no logic drift).
    // >1 day overlap with any existing assignment blocks the assignment.
    const conflicts = assignments
      .map((a) => ({
        name: a.memberName,
        startDate: a.startDate,
        endDate: a.endDate,
        days: calculateOverlapDays(
          start,
          end,
          parseDateOnly(a.startDate),
          parseDateOnly(a.endDate),
        ),
      }))
      .filter((c) => c.days > 1);

    return {
      name: target.memberName,
      startDate: selection.startDate,
      endDate: selection.endDate,
      nights,
      fills,
      conflicts,
    };
  }, [target, selection.startDate, selection.endDate, assignments, redDatesByMonth]);

  const today = formatDateOnly(getTodayDateOnly());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{hutLeaderLabel} Assignments</h1>
        <p className="mt-1 text-sm text-slate-500">
          Paint the calendar: assign a member as {hutLeaderLabel.toLowerCase()} for
          the nights that need cover.
        </p>
      </div>

      {/*
        Page-level (more prominent than a form-scoped banner): reset-PIN errors
        originate in the assignments table, so a form banner would never show
        them. This guarantees every error — create, reset-PIN — is visible
        without scrolling.
      */}
      {error && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error.message}
        </div>
      )}

      {unassignedDates.length > 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-amber-800">
              <CalendarDays className="h-5 w-5" />
              Upcoming Dates Without {hutLeaderLabel} ({unassignedDates.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {unassignedDates.map((d) => (
                <div
                  key={d.date}
                  className="flex items-center justify-between rounded-lg border border-amber-200 bg-white px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-800">{d.date}</p>
                    <p className="text-xs text-slate-500">
                      {d.bookingCount} booking{d.bookingCount !== 1 ? "s" : ""},{" "}
                      {d.guestCount} guest{d.guestCount !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleAssignForDate(d.date)}
                    className="text-xs"
                  >
                    Assign
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <AssignmentForm
        hutLeaderLabel={hutLeaderLabel}
        selectedStartDate={selection.startDate}
        selectedEndDate={selection.endDate}
        onPickNights={handlePickNights}
        onVisibleMonthChange={handleVisibleMonthChange}
        overlayByDate={overlayByDate}
        overlayLegend={overlayLegend}
        eligibleMembers={eligibleMembers}
        loadingMembers={loadingMembers}
        target={target}
        onSelectEligible={handleSelectEligible}
        onSelectAnyMember={handleSelectAnyMember}
        onClearTarget={() => setTarget(null)}
        summary={summary}
        creating={creating}
        error={error}
        onConfirm={handleConfirm}
        lodgeSelector={
          <LodgeSelect
            lodges={lodges}
            value={lodgeId}
            onChange={setLodgeId}
            loading={lodgesLoading}
          />
        }
      />

      {pinMessage && (
        <Card className="border-blue-200 bg-blue-50">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-blue-900">
                New kiosk PIN for {pinMessage.memberName}
              </p>
              <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.25em] text-blue-950">
                {pinMessage.pin}
              </p>
              <p className="mt-1 text-xs text-blue-800">
                This PIN is shown once.{" "}
                {pinMessage.emailSent
                  ? `It has also been emailed to the ${hutLeaderLabel.toLowerCase()}.`
                  : "Email delivery failed, so provide it directly."}
              </p>
            </div>
            <Button type="button" variant="outline" onClick={() => setPinMessage(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-center text-slate-500">Loading...</div>
          ) : assignments.length === 0 ? (
            <div className="p-6 text-center text-slate-500">
              No {hutLeaderLabel.toLowerCase()} assignments yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Member</th>
                    {showLodgeColumn && (
                      <th className="px-4 py-3 text-left font-medium text-slate-600">Lodge</th>
                    )}
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Start</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">End</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Status</th>
                    <th className="px-4 py-3 text-right font-medium text-slate-600">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((a) => {
                    const isActive = a.startDate <= today && a.endDate >= today;
                    const isPast = a.endDate < today;
                    return (
                      <tr key={a.id} className="border-b hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <UserCheck className="h-4 w-4 text-slate-400" />
                            <div>
                              <div className="font-medium">{a.memberName}</div>
                              <div className="text-xs text-slate-500">{a.memberEmail}</div>
                            </div>
                          </div>
                        </td>
                        {showLodgeColumn && (
                          <td className="px-4 py-3">{a.lodgeName ?? "—"}</td>
                        )}
                        <td className="px-4 py-3">{a.startDate}</td>
                        <td className="px-4 py-3">{a.endDate}</td>
                        <td className="px-4 py-3">
                          {isActive ? (
                            <Badge className="border-green-200 bg-green-100 text-green-800">Active</Badge>
                          ) : isPast ? (
                            <Badge variant="secondary">Past</Badge>
                          ) : (
                            <Badge className="border-blue-200 bg-blue-100 text-blue-800">Upcoming</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleResetPin(a)}
                              disabled={resettingPinId === a.id}
                              className="text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                              title="Reset kiosk PIN"
                            >
                              <KeyRound className="h-4 w-4" />
                              <span className="sr-only">Reset kiosk PIN</span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(a.id)}
                              className="text-red-600 hover:bg-red-50 hover:text-red-700"
                              title="Delete assignment"
                            >
                              <Trash2 className="h-4 w-4" />
                              <span className="sr-only">Delete assignment</span>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
