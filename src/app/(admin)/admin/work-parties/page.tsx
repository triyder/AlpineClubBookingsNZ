"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useLodgeOptions } from "@/components/lodge-select";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { APP_TIME_ZONE } from "@/config/operational";
import { formatDateOnlyForTimeZone } from "@/lib/date-only";
import { formatCents } from "@/lib/pricing";

interface WorkPartyEventRow {
  id: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string;
  discountPercent: number;
  active: boolean;
  lodgeId: string | null;
  lodgeName: string | null;
  bookingCount: number;
  totalDiscountCents: number;
}

interface AttendingBooking {
  id: string;
  discountCents: number;
  createdAt: string;
  booking: {
    id: string;
    checkIn: string;
    checkOut: string;
    status: string;
    finalPriceCents: number;
  };
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
}

interface EventDetail {
  attendingBookings: AttendingBooking[];
  totalDiscountCents: number;
}

interface EventFormState {
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  discountPercent: string;
  active: boolean;
  // Lodge the working bee is held at; "" means club-wide (all lodges).
  lodgeId: string;
}

const emptyForm: EventFormState = {
  name: "",
  description: "",
  startDate: "",
  endDate: "",
  discountPercent: "100",
  active: true,
  lodgeId: "",
};

function formatStoredDate(value: string) {
  return formatDateOnlyForTimeZone(new Date(value), APP_TIME_ZONE);
}

export default function AdminWorkPartiesPage() {
  // Work-party events are lodge config; the write routes enforce lodge:edit, so
  // a lodge:view admin sees this screen read-only (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  const [events, setEvents] = useState<WorkPartyEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EventFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, EventDetail>>({});
  // Lodge options for the form's lodge field and per-event lodge labels; the
  // field and labels only render once a second lodge exists (ADR-002).
  const { lodges } = useLodgeOptions("admin");

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/work-parties");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to load work party events");
        return;
      }
      setEvents(data.events);
    } catch {
      setError("Failed to load work party events");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
    setError("");
  }

  function startEdit(event: WorkPartyEventRow) {
    setEditingId(event.id);
    setForm({
      name: event.name,
      description: event.description ?? "",
      startDate: event.startDate.slice(0, 10),
      endDate: event.endDate.slice(0, 10),
      discountPercent: String(event.discountPercent),
      active: event.active,
      lodgeId: event.lodgeId ?? "",
    });
    setShowForm(true);
    setError("");
  }

  async function handleSave() {
    const discountPercent = Number(form.discountPercent);
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    if (!form.startDate || !form.endDate) {
      setError("Start and end dates are required");
      return;
    }
    if (!Number.isInteger(discountPercent) || discountPercent < 1 || discountPercent > 100) {
      setError("Discount must be a whole number between 1 and 100");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        startDate: form.startDate,
        endDate: form.endDate,
        discountPercent,
        active: form.active,
        lodgeId: form.lodgeId || null,
      };
      const res = await fetch(
        editingId ? `/api/admin/work-parties/${editingId}` : "/api/admin/work-parties",
        {
          method: editingId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to save work party event");
        return;
      }
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm);
      await fetchEvents();
    } catch {
      setError("Failed to save work party event");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(event: WorkPartyEventRow) {
    setError("");
    const res = await fetch(`/api/admin/work-parties/${event.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: event.name,
        description: event.description,
        startDate: event.startDate.slice(0, 10),
        endDate: event.endDate.slice(0, 10),
        discountPercent: event.discountPercent,
        active: !event.active,
        lodgeId: event.lodgeId,
      }),
    });
    if (res.status === 403) {
      setError(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Failed to update work party event");
      return;
    }
    await fetchEvents();
  }

  async function handleDelete(event: WorkPartyEventRow) {
    if (!confirm(`Delete work party event "${event.name}"?`)) return;
    setError("");
    const res = await fetch(`/api/admin/work-parties/${event.id}`, {
      method: "DELETE",
    });
    if (res.status === 403) {
      setError(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Failed to delete work party event");
      return;
    }
    await fetchEvents();
  }

  async function toggleDetail(eventId: string) {
    if (expandedId === eventId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(eventId);
    if (!details[eventId]) {
      const res = await fetch(`/api/admin/work-parties/${eventId}`);
      const data = await res.json();
      if (res.ok) {
        setDetails((prev) => ({
          ...prev,
          [eventId]: {
            attendingBookings: data.attendingBookings,
            totalDiscountCents: data.totalDiscountCents,
          },
        }));
      }
    }
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Work Parties"
        description="Working bee events with an automatic discount for attending bookings"
        actions={
          <ViewOnlyActionButton canEdit={canEdit} onClick={startCreate}>
            New Event
          </ViewOnlyActionButton>
        }
      />

      {!canEdit && (
        <AdminViewOnlyNotice>
          Your admin role can view work parties but cannot change them. Lodge
          edit access is required.
        </AdminViewOnlyNotice>
      )}

      {error && (
        <div className="rounded-md border border-danger/20 bg-danger-muted p-3 text-sm text-danger">{error}</div>
      )}

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>{editingId ? "Edit Event" : "New Event"}</CardTitle>
            <CardDescription>
              Members booking nights within the event window can tick &quot;I am
              attending a working bee&quot; to receive the discount automatically.
              The discount applies to every guest&apos;s nights inside the window.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="wp-name">Name</Label>
                <Input
                  id="wp-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Spring working bee"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wp-discount">Discount %</Label>
                <Input
                  id="wp-discount"
                  type="number"
                  min={1}
                  max={100}
                  value={form.discountPercent}
                  onChange={(e) => setForm({ ...form, discountPercent: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wp-start">Start date</Label>
                <Input
                  id="wp-start"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wp-end">End date (last discounted night)</Label>
                <Input
                  id="wp-end"
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                />
              </div>
              {lodges.length > 1 && (
                <div className="space-y-2">
                  <Label htmlFor="wp-lodge">Lodge</Label>
                  <select
                    id="wp-lodge"
                    value={form.lodgeId}
                    onChange={(e) => setForm({ ...form, lodgeId: e.target.value })}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                  >
                    <option value="">All lodges (club-wide)</option>
                    {lodges.map((lodge) => (
                      <option key={lodge.id} value={lodge.id}>
                        {lodge.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="wp-description">Description (optional)</Label>
              <Textarea
                id="wp-description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                maxLength={1000}
                rows={3}
              />
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                className="rounded border-input"
              />
              Active (members can select this event when booking)
            </label>
            <div className="flex gap-2">
              <ViewOnlyActionButton canEdit={canEdit} onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : editingId ? "Save Changes" : "Create Event"}
              </ViewOnlyActionButton>
              <Button
                variant="outline"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner label="Loading work party events…" />
        </div>
      ) : events.length === 0 ? (
        <Card>
          <EmptyState
            icon={CalendarDays}
            title="No work party events yet"
            description="Create one to offer an automatic working bee discount on nights in the window."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {events.map((event) => (
            <Card key={event.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {event.name}
                      <Badge variant={event.active ? "default" : "secondary"}>
                        {event.active ? "Active" : "Inactive"}
                      </Badge>
                    </CardTitle>
                    <CardDescription>
                      {formatStoredDate(event.startDate)} to {formatStoredDate(event.endDate)}
                      {" · "}
                      {event.discountPercent}% off nights in the window
                      {lodges.length > 1 && (
                        <>
                          {" · "}
                          {event.lodgeName ?? "All lodges"}
                        </>
                      )}
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <ViewOnlyActionButton canEdit={canEdit} variant="outline" size="sm" onClick={() => startEdit(event)}>
                      Edit
                    </ViewOnlyActionButton>
                    <ViewOnlyActionButton canEdit={canEdit} variant="outline" size="sm" onClick={() => toggleActive(event)}>
                      {event.active ? "Deactivate" : "Activate"}
                    </ViewOnlyActionButton>
                    {event.bookingCount === 0 && (
                      <ViewOnlyActionButton canEdit={canEdit} variant="outline" size="sm" onClick={() => handleDelete(event)}>
                        Delete
                      </ViewOnlyActionButton>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {event.description && (
                  <p className="text-sm text-muted-foreground">{event.description}</p>
                )}
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <span>
                    Attending bookings: <strong>{event.bookingCount}</strong>
                  </span>
                  <span>
                    Total discount given: <strong>{formatCents(event.totalDiscountCents)}</strong>
                  </span>
                  {event.bookingCount > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => toggleDetail(event.id)}>
                      {expandedId === event.id ? "Hide bookings" : "Show bookings"}
                    </Button>
                  )}
                </div>
                {expandedId === event.id &&
                  (details[event.id] ? (
                    <AdminDataTable showDensityToggle={false}>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Member</TableHead>
                          <TableHead>Stay</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Discount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {details[event.id].attendingBookings.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell>
                              {row.member.firstName} {row.member.lastName}
                            </TableCell>
                            <TableCell>
                              {formatStoredDate(row.booking.checkIn)} to{" "}
                              {formatStoredDate(row.booking.checkOut)}
                            </TableCell>
                            <TableCell>{row.booking.status}</TableCell>
                            <TableCell className="text-right">
                              {formatCents(row.discountCents)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </AdminDataTable>
                  ) : (
                    <div className="rounded-md border p-3 text-sm text-muted-foreground">
                      Loading bookings...
                    </div>
                  ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
