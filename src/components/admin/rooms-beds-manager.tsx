"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BedDouble,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  LodgeSelect,
  initialLodgeIdFromLocation,
  useLodgeOptions,
} from "@/components/lodge-select";
import {
  BedTypeIndicator,
  type BedTypeValue,
} from "@/components/admin/bed-type-indicator";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { LodgeCapacityStatus } from "@/lib/lodge-capacity";

const BED_TYPE_OPTIONS: Array<{ value: BedTypeValue; label: string }> = [
  { value: "SINGLE", label: "Single" },
  { value: "BUNK_TOP", label: "Bunk (top)" },
  { value: "BUNK_BOTTOM", label: "Bunk (bottom)" },
  { value: "DOUBLE", label: "Double" },
];

function isBunkTypeValue(value: string): boolean {
  return value === "BUNK_TOP" || value === "BUNK_BOTTOM";
}

// Pairing label for a grouped bunk, e.g. "Bunk A · top"; undefined when the bed
// is not a grouped bunk (the indicator then shows its own type label).
function bunkPairingLabel(
  bedType: BedTypeValue,
  bunkGroup: string,
): string | undefined {
  const group = bunkGroup.trim();
  if (!group) return undefined;
  if (bedType === "BUNK_TOP") return `${group} · top`;
  if (bedType === "BUNK_BOTTOM") return `${group} · bottom`;
  return undefined;
}

// Soft, non-blocking hint shown when a bunk-typed bed has no partner yet —
// either no group at all, or a group that still holds only this one bed (its
// partner was never added or was deleted).
const BUNK_UNPAIRED_HINT =
  "Unpaired bunk — pair a top and a bottom under the same bunk group.";

interface DashboardBed {
  id: string;
  roomId: string;
  name: string;
  sortOrder: number;
  active: boolean;
  bedType: BedTypeValue;
  bunkGroup: string | null;
}

interface DashboardRoom {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  notes: string | null;
  beds: DashboardBed[];
}

interface RoomsBedsPayload {
  rooms: DashboardRoom[];
  capacity: LodgeCapacityStatus;
  canImportFromConfig: boolean;
  configBeds: Array<{
    id: string;
    name: string;
    capacity: number;
    type: string;
  }>;
}

interface RoomDraft {
  name: string;
  sortOrder: string;
  active: boolean;
  notes: string;
}

interface BedDraft {
  name: string;
  sortOrder: string;
  active: boolean;
  bedType: BedTypeValue;
  // Held as a string for the controlled input; "" means no group.
  bunkGroup: string;
}

const EMPTY_BED_DRAFT: BedDraft = {
  name: "",
  sortOrder: "0",
  active: true,
  bedType: "SINGLE",
  bunkGroup: "",
};

async function readApiError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

function roomEditFromRoom(room: DashboardRoom): RoomDraft {
  return {
    name: room.name,
    sortOrder: String(room.sortOrder),
    active: room.active,
    notes: room.notes ?? "",
  };
}

function bedEditFromBed(bed: DashboardBed): BedDraft {
  return {
    name: bed.name,
    sortOrder: String(bed.sortOrder),
    active: bed.active,
    // Defensive defaults keep the manager tolerant of an older payload that
    // predates bedType/bunkGroup.
    bedType: bed.bedType ?? "SINGLE",
    bunkGroup: bed.bunkGroup ?? "",
  };
}

function roomDraftsEqual(a: RoomDraft, b: RoomDraft): boolean {
  return (
    a.name === b.name &&
    a.sortOrder === b.sortOrder &&
    a.active === b.active &&
    a.notes === b.notes
  );
}

function bedDraftsEqual(a: BedDraft, b: BedDraft): boolean {
  return (
    a.name === b.name &&
    a.sortOrder === b.sortOrder &&
    a.active === b.active &&
    a.bedType === b.bedType &&
    a.bunkGroup === b.bunkGroup
  );
}

// Describes the row a save just wrote, carrying the exact draft that was sent
// so the merge can tell an unchanged row (re-sync to server) from one the admin
// kept editing mid-flight (keep the newer draft). null = a plain refresh.
type SavedDraft =
  | { kind: "room"; id: string; sent: RoomDraft }
  | { kind: "bed"; id: string; sent: BedDraft }
  | null;

// A draft is dirty when it differs from the current server-derived draft. Beds
// and rooms always have a seeded edit after the first load, so `existing`
// truthiness alone can't decide dirtiness — the value comparison does.
//
// On refetch we keep every dirty draft. The just-saved row (named in `saved`)
// re-syncs to the server value — so a server-side normalisation like a trimmed
// name or "05" -> 5 doesn't leave a phantom "unsaved" badge — BUT only when its
// draft is still what we sent; if the admin typed more while the save was in
// flight, that newer draft wins and stays dirty. Entities missing from the
// payload (deleted server-side) drop out; new entities seed a fresh draft.
function mergeRoomEdits(
  prev: Record<string, RoomDraft>,
  rooms: DashboardRoom[],
  saved: SavedDraft,
): Record<string, RoomDraft> {
  const next: Record<string, RoomDraft> = {};
  for (const room of rooms) {
    const serverDraft = roomEditFromRoom(room);
    const existing = prev[room.id];
    if (existing === undefined) {
      next[room.id] = serverDraft;
    } else if (saved?.kind === "room" && saved.id === room.id) {
      next[room.id] = roomDraftsEqual(existing, saved.sent) ? serverDraft : existing;
    } else {
      next[room.id] = roomDraftsEqual(existing, serverDraft) ? serverDraft : existing;
    }
  }
  return next;
}

function mergeBedEdits(
  prev: Record<string, BedDraft>,
  rooms: DashboardRoom[],
  saved: SavedDraft,
): Record<string, BedDraft> {
  const next: Record<string, BedDraft> = {};
  for (const room of rooms) {
    for (const bed of room.beds) {
      const serverDraft = bedEditFromBed(bed);
      const existing = prev[bed.id];
      if (existing === undefined) {
        next[bed.id] = serverDraft;
      } else if (saved?.kind === "bed" && saved.id === bed.id) {
        next[bed.id] = bedDraftsEqual(existing, saved.sent) ? serverDraft : existing;
      } else {
        next[bed.id] = bedDraftsEqual(existing, serverDraft) ? serverDraft : existing;
      }
    }
  }
  return next;
}

// Room-keyed client state (the per-room Add Bed draft, the per-room delete
// error) is not covered by the bed/room edit merges, so a room that vanishes
// server-side (a delete) would leave its entry orphaned. Prune to the rooms
// still present, mirroring how the edit merges drop absent entities.
function pruneByRoomId<T>(
  byRoomId: Record<string, T>,
  roomIds: Set<string>,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [roomId, value] of Object.entries(byRoomId)) {
    if (roomIds.has(roomId)) next[roomId] = value;
  }
  return next;
}

export function RoomsBedsManager({
  permissionMatrix,
}: {
  permissionMatrix: AdminPermissionMatrix;
}) {
  const { confirm, confirmDialog } = useConfirm();
  // The bed-allocation APIs behind this manager enforce the bookings area even
  // though the page route is lodge area. Gate the whole manager at bookings
  // `view` so a narrow custom role (lodge without bookings) renders nothing
  // rather than toasting a raw 403; seeded roles with lodge access all hold
  // bookings, so they are unaffected.
  const canManageBeds = permissionMatrix.bookings !== "none";
  const [forbidden, setForbidden] = useState(false);
  const [payload, setPayload] = useState<RoomsBedsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [roomDraft, setRoomDraft] = useState<RoomDraft>({
    name: "",
    sortOrder: "0",
    active: true,
    notes: "",
  });
  const [roomEdits, setRoomEdits] = useState<Record<string, RoomDraft>>({});
  const [bedDrafts, setBedDrafts] = useState<Record<string, BedDraft>>({});
  const [bedEdits, setBedEdits] = useState<Record<string, BedDraft>>({});
  // Per-room delete failure, shown inline below the room row (under its
  // name/active/save controls) so a guard rejection ("deactivate instead")
  // persists as an actionable message rather than a transient toast.
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  // Inline bunk-pairing (and other) errors from the bed create/save endpoints,
  // surfaced next to the form the way room-delete guard failures are — a typed
  // 409/400 like "two tops" or the concurrency race must be actionable, not a
  // transient toast. Add-form errors key by roomId; per-bed edit errors by bedId.
  const [bedFormErrors, setBedFormErrors] = useState<Record<string, string>>({});
  const [bedEditErrors, setBedEditErrors] = useState<Record<string, string>>({});
  // Monotonic counter so an out-of-order refetch (overlapping saves) can't apply
  // a stale payload after a newer request has already landed.
  const loadSeqRef = useRef(0);
  // Lodge context for the page; LodgeSelect renders nothing (and reports the
  // sole lodge) while fewer than two lodges exist (ADR-002).
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin");
  // Hub links (ADR-003) land pre-filtered; read synchronously so the first
  // fetch is already lodge-filtered.
  const [lodgeId, setLodgeId] = useState<string | null>(initialLodgeIdFromLocation);
  const [bulkRoomCount, setBulkRoomCount] = useState("");
  const [bulkBedsPerRoom, setBulkBedsPerRoom] = useState("4");
  const [bulkNamePrefix, setBulkNamePrefix] = useState("Room");

  const totalBeds = useMemo(
    () => payload?.rooms.reduce((total, room) => total + room.beds.length, 0) ?? 0,
    [payload],
  );

  const isRoomDirty = useCallback(
    (room: DashboardRoom) => {
      const edit = roomEdits[room.id];
      return edit !== undefined && !roomDraftsEqual(edit, roomEditFromRoom(room));
    },
    [roomEdits],
  );

  const isBedDirty = useCallback(
    (bed: DashboardBed) => {
      const edit = bedEdits[bed.id];
      return edit !== undefined && !bedDraftsEqual(edit, bedEditFromBed(bed));
    },
    [bedEdits],
  );

  const loadRooms = useCallback(async (signal?: AbortSignal, saved: SavedDraft = null) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const response = await fetch(
        lodgeId
          ? `/api/admin/bed-allocation/rooms?lodgeId=${encodeURIComponent(lodgeId)}`
          : "/api/admin/bed-allocation/rooms",
        {
          cache: "no-store",
          signal,
        },
      );
      // In-manager backstop: the page normally hides this manager by matrix, so
      // a denial here means matrix↔enforcement drift or a mid-session
      // revocation — render nothing quietly instead of toasting a raw 403.
      // Genuine failures (5xx/network) keep the toast below.
      if (response.status === 401 || response.status === 403) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            "RoomsBedsManager: bed-allocation fetch denied; hiding manager (matrix/enforcement drift or revoked session?)",
          );
        }
        setForbidden(true);
        return;
      }
      if (!response.ok) {
        throw new Error(await readApiError(response, "Failed to load rooms and beds"));
      }

      const data = (await response.json()) as RoomsBedsPayload;
      // A newer load started while this one was in flight — drop this (stale)
      // payload so it can't clobber the fresher list/drafts.
      if (seq !== loadSeqRef.current) return;
      setPayload(data);
      // Preserve every unsaved draft across the refetch; only the just-saved
      // row and untouched rows re-sync to server state (see mergeRoomEdits).
      setRoomEdits((prev) => mergeRoomEdits(prev, data.rooms, saved));
      setBedEdits((prev) => mergeBedEdits(prev, data.rooms, saved));
      // Drop room-keyed state (Add Bed drafts, delete errors) for rooms that
      // disappeared server-side so a deleted room leaves nothing behind.
      const roomIds = new Set(data.rooms.map((room) => room.id));
      setBedDrafts((prev) => pruneByRoomId(prev, roomIds));
      setDeleteErrors((prev) => pruneByRoomId(prev, roomIds));
      setBedFormErrors((prev) => pruneByRoomId(prev, roomIds));
      // Per-bed edit errors drop with the bed that owned them (pruneByRoomId is
      // a generic id-keyed prune; here the keys are bed ids).
      const bedIds = new Set(
        data.rooms.flatMap((room) => room.beds.map((bed) => bed.id)),
      );
      setBedEditErrors((prev) => pruneByRoomId(prev, bedIds));
    } catch (error) {
      // An aborted request means the lodge changed (or the page unmounted);
      // a newer request owns the list now.
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      toast.error(error instanceof Error ? error.message : "Failed to load rooms and beds");
    } finally {
      // Only the latest request owns the loading flag; a superseded one must not
      // clear it while the newer fetch is still running.
      if (seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [lodgeId]);

  useEffect(() => {
    // Skip the bookings-area fetch entirely for a viewer who lacks bookings
    // access; the manager renders nothing for them (below).
    if (!canManageBeds) return;
    const controller = new AbortController();
    void loadRooms(controller.signal);
    return () => controller.abort();
  }, [loadRooms, canManageBeds]);

  // Returns true only when the request succeeded, so callers can clear an
  // add-form draft on success and preserve it on failure.
  async function mutate(
    label: string,
    request: () => Promise<Response>,
    success: string,
    // The row this write just saved, so the follow-up refetch can re-sync it to
    // the returned server state (see loadRooms / mergeRoomEdits).
    saved?: SavedDraft,
    // Optional inline-error sink: the failure still toasts, but callers that
    // render an inline message (bed create/save) also receive the text here.
    onError?: (message: string) => void,
  ): Promise<boolean> {
    setSaving(label);
    try {
      const response = await request();
      if (!response.ok) {
        throw new Error(await readApiError(response, "Request failed"));
      }
      toast.success(success);
      await loadRooms(undefined, saved);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      toast.error(message);
      onError?.(message);
      return false;
    } finally {
      setSaving(null);
    }
  }

  function updateRoomEdit(roomId: string, patch: Partial<RoomDraft>) {
    setRoomEdits((current) => ({
      ...current,
      [roomId]: {
        ...(current[roomId] ?? {
          name: "",
          sortOrder: "0",
          active: true,
          notes: "",
        }),
        ...patch,
      },
    }));
  }

  // Changing a bed away from a bunk type clears any typed group so the two
  // fields never disagree (a group without a bunk type is a server error).
  function normalizeBedTypePatch(patch: Partial<BedDraft>): Partial<BedDraft> {
    if (patch.bedType !== undefined && !isBunkTypeValue(patch.bedType)) {
      return { ...patch, bunkGroup: "" };
    }
    return patch;
  }

  function updateBedDraft(roomId: string, patch: Partial<BedDraft>) {
    const applied = normalizeBedTypePatch(patch);
    setBedDrafts((current) => ({
      ...current,
      [roomId]: {
        ...(current[roomId] ?? EMPTY_BED_DRAFT),
        ...applied,
      },
    }));
  }

  function updateBedEdit(bedId: string, patch: Partial<BedDraft>) {
    const applied = normalizeBedTypePatch(patch);
    setBedEdits((current) => ({
      ...current,
      [bedId]: {
        ...(current[bedId] ?? EMPTY_BED_DRAFT),
        ...applied,
      },
    }));
  }

  async function createRoom() {
    const created = await mutate(
      "room-new",
      () =>
        fetch("/api/admin/bed-allocation/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: roomDraft.name,
            sortOrder: Number(roomDraft.sortOrder || 0),
            active: roomDraft.active,
            notes: roomDraft.notes || null,
            // Lodge is set at creation from the page's lodge context.
            ...(lodgeId ? { lodgeId } : {}),
          }),
        }),
      "Room created",
    );
    // Keep the typed values on failure so a transient error doesn't lose them.
    if (created) {
      setRoomDraft({ name: "", sortOrder: "0", active: true, notes: "" });
    }
  }

  async function saveRoom(roomId: string) {
    const draft = roomEdits[roomId];
    if (!draft) return;

    const saved = await mutate(
      `room-${roomId}`,
      () =>
        fetch(`/api/admin/bed-allocation/rooms/${roomId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: draft.name,
            sortOrder: Number(draft.sortOrder || 0),
            active: draft.active,
            notes: draft.notes || null,
          }),
        }),
      "Room saved",
      { kind: "room", id: roomId, sent: draft },
    );
    // A successful save clears any lingering delete-guard message — e.g. after
    // the admin follows the steer and deactivates the room instead.
    if (saved) clearDeleteError(roomId);
  }

  async function createBed(roomId: string) {
    const draft = bedDrafts[roomId] ?? EMPTY_BED_DRAFT;
    clearBedFormError(roomId);

    const created = await mutate(
      `bed-new-${roomId}`,
      () =>
        fetch("/api/admin/bed-allocation/beds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roomId,
            name: draft.name,
            sortOrder: Number(draft.sortOrder || 0),
            active: draft.active,
            bedType: draft.bedType,
            bunkGroup: draft.bunkGroup.trim() || null,
          }),
        }),
      "Bed created",
      undefined,
      (message) =>
        setBedFormErrors((current) => ({ ...current, [roomId]: message })),
    );
    // Keep the typed values on failure so a transient error doesn't lose them.
    if (created) {
      setBedDrafts((current) => ({ ...current, [roomId]: EMPTY_BED_DRAFT }));
    }
  }

  async function saveBed(bedId: string) {
    const draft = bedEdits[bedId];
    if (!draft) return;
    clearBedEditError(bedId);

    await mutate(
      `bed-${bedId}`,
      () =>
        fetch(`/api/admin/bed-allocation/beds/${bedId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: draft.name,
            sortOrder: Number(draft.sortOrder || 0),
            active: draft.active,
            bedType: draft.bedType,
            bunkGroup: draft.bunkGroup.trim() || null,
          }),
        }),
      "Bed saved",
      { kind: "bed", id: bedId, sent: draft },
      (message) =>
        setBedEditErrors((current) => ({ ...current, [bedId]: message })),
    );
  }

  function clearBedFormError(roomId: string) {
    setBedFormErrors((current) => {
      if (!(roomId in current)) return current;
      const next = { ...current };
      delete next[roomId];
      return next;
    });
  }

  function clearBedEditError(bedId: string) {
    setBedEditErrors((current) => {
      if (!(bedId in current)) return current;
      const next = { ...current };
      delete next[bedId];
      return next;
    });
  }

  async function deleteBed(bedId: string) {
    if (
      !(await confirm({
        title: "Delete this bed?",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return;

    await mutate(
      `bed-delete-${bedId}`,
      () =>
        fetch(`/api/admin/bed-allocation/beds/${bedId}`, {
          method: "DELETE",
        }),
      "Bed deleted",
    );
  }

  function clearDeleteError(roomId: string) {
    setDeleteErrors((current) => {
      if (!(roomId in current)) return current;
      const next = { ...current };
      delete next[roomId];
      return next;
    });
  }

  // deleteRoom does not go through mutate(): a guard rejection must surface
  // inline (below the room row) instead of as a toast, so it reads the error
  // message itself and stores it per room. The Active toggle stays visible as
  // the steered "deactivate instead" alternative.
  async function deleteRoom(roomId: string) {
    if (
      !(await confirm({
        title: "Delete this room?",
        description:
          "This room and all of its beds will be permanently deleted. A room with any bed-allocation history can't be deleted — deactivate it instead.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return;

    setSaving(`room-delete-${roomId}`);
    clearDeleteError(roomId);
    try {
      const response = await fetch(`/api/admin/bed-allocation/rooms/${roomId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const message = await readApiError(response, "Failed to delete room");
        setDeleteErrors((current) => ({ ...current, [roomId]: message }));
        return;
      }
      toast.success("Room deleted");
      await loadRooms();
    } catch (error) {
      setDeleteErrors((current) => ({
        ...current,
        [roomId]:
          error instanceof Error ? error.message : "Failed to delete room",
      }));
    } finally {
      setSaving(null);
    }
  }

  async function bulkCreateRooms() {
    const roomCount = Number(bulkRoomCount);
    const bedsPerRoom = Number(bulkBedsPerRoom || 0);
    const created = await mutate(
      "rooms-bulk",
      () =>
        fetch("/api/admin/bed-allocation/rooms/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roomCount,
            bedsPerRoom,
            namePrefix: bulkNamePrefix.trim() || undefined,
            ...(lodgeId ? { lodgeId } : {}),
          }),
        }),
      `Created ${roomCount} room${roomCount === 1 ? "" : "s"}`,
    );
    // Keep the typed count on failure so a transient error doesn't lose it.
    if (created) {
      setBulkRoomCount("");
    }
  }

  async function importFromConfig() {
    await mutate(
      "import-config",
      () =>
        fetch("/api/admin/bed-allocation/rooms/import-from-config", {
          method: "POST",
        }),
      "Rooms and beds imported",
    );
  }

  // Quiet render-nothing backstop: a viewer without bookings access (or a drift
  // denial) sees nothing rather than a broken shell with a 403 toast. This
  // manager owns the page's only heading, so the whole page is blank for them.
  if (!canManageBeds || forbidden) {
    return null;
  }

  return (
    <div className="space-y-6">
      {confirmDialog}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Rooms & Beds</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            {payload ? (
              <>
                <Badge variant="secondary">{payload.rooms.length} rooms</Badge>
                <Badge variant="secondary">{totalBeds} beds</Badge>
                <Badge
                  variant={
                    payload.capacity.source === "configured_beds"
                      ? "success"
                      : "warning"
                  }
                >
                  Capacity {payload.capacity.capacity}
                </Badge>
              </>
            ) : null}
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => void loadRooms()}
          disabled={loading}
          className="gap-2 md:w-auto"
        >
          <LoaderCircle className={loading ? "h-4 w-4 animate-spin" : "hidden"} />
          Refresh
        </Button>
      </div>

      <div className="max-w-xs">
        <LodgeSelect lodges={lodges} value={lodgeId} onChange={setLodgeId} loading={lodgesLoading} />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border bg-white p-6 text-sm text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading rooms and beds
        </div>
      ) : null}

      {payload?.capacity.bedAllocationEnabled &&
      payload.capacity.activeBedCount === 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="mb-1 flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            Capacity fallback active
          </div>
          Booking capacity is using {payload.capacity.fallbackCapacity} beds from
          club config until at least one active bed is configured.
        </div>
      ) : null}

      {payload?.capacity.source === "capped_beds" ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="mb-1 flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            Sleeping capacity capped below the installed beds
          </div>
          {payload.capacity.activeBedCount} active bed
          {payload.capacity.activeBedCount === 1 ? " is" : "s are"} configured, but
          this lodge is capped at {payload.capacity.capacity}. The extra{" "}
          {payload.capacity.activeBedCount - payload.capacity.capacity} bed
          {payload.capacity.activeBedCount - payload.capacity.capacity === 1
            ? ""
            : "s"}{" "}
          stay available for allocation but cannot be booked into. Change the
          capacity on the lodge&apos;s configuration page.
        </div>
      ) : null}

      {payload?.canImportFromConfig ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Upload className="h-4 w-4" />
              Import From Config
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="text-sm text-muted-foreground">
              {payload.configBeds
                .map((bed) => `${bed.name}: ${bed.capacity}`)
                .join(", ")}
            </div>
            <Button
              onClick={() => void importFromConfig()}
              disabled={saving === "import-config"}
              className="gap-2 md:w-auto"
            >
              <Upload className="h-4 w-4" />
              Import
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {payload ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plus className="h-4 w-4" />
              Quick Add Rooms
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Seed several rooms at once — for example 8 rooms of 4 beds —
              then rename or adjust them individually below.
            </p>
            <div className="grid gap-3 md:grid-cols-[110px_130px_1fr_auto]">
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">Rooms</span>
                <Input
                  type="number"
                  min="1"
                  max="50"
                  placeholder="8"
                  value={bulkRoomCount}
                  onChange={(event) => setBulkRoomCount(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">Beds per room</span>
                <Input
                  type="number"
                  min="0"
                  max="20"
                  value={bulkBedsPerRoom}
                  onChange={(event) => setBulkBedsPerRoom(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">Name prefix</span>
                <Input
                  value={bulkNamePrefix}
                  onChange={(event) => setBulkNamePrefix(event.target.value)}
                  placeholder="Room"
                />
              </div>
              <div className="flex items-end">
                <Button
                  onClick={() => void bulkCreateRooms()}
                  disabled={
                    saving === "rooms-bulk" ||
                    !bulkRoomCount ||
                    Number(bulkRoomCount) < 1
                  }
                  className="gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Create
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {payload ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BedDouble className="h-4 w-4" />
              Room Inventory
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 md:grid-cols-[2fr_90px_1fr_auto_auto]">
              <Input
                placeholder="Room name"
                value={roomDraft.name}
                onChange={(event) =>
                  setRoomDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
              <Input
                type="number"
                min="0"
                value={roomDraft.sortOrder}
                onChange={(event) =>
                  setRoomDraft((current) => ({
                    ...current,
                    sortOrder: event.target.value,
                  }))
                }
              />
              <Textarea
                placeholder="Notes"
                value={roomDraft.notes}
                onChange={(event) =>
                  setRoomDraft((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
                className="min-h-9"
              />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={roomDraft.active}
                  onCheckedChange={(checked) =>
                    setRoomDraft((current) => ({
                      ...current,
                      active: checked === true,
                    }))
                  }
                />
                Active
              </label>
              <Button
                onClick={() => void createRoom()}
                disabled={saving === "room-new"}
                className="gap-2"
              >
                <Plus className="h-4 w-4" />
                Add Room
              </Button>
            </div>

            {payload.rooms.length === 0 ? (
              <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                No rooms configured.
              </div>
            ) : (
              <div className="space-y-6">
                {payload.rooms.map((room) => {
                  const edit = roomEdits[room.id] ?? roomEditFromRoom(room);
                  const bedDraft = bedDrafts[room.id] ?? EMPTY_BED_DRAFT;
                  // Count persisted beds per bunk group so a bunk only reads as
                  // "paired" (pairing label, no warning) once its group holds
                  // two beds. A lone survivor of a deleted partner shows the
                  // soft unpaired hint instead of implying a partner.
                  const bunkGroupCounts = new Map<string, number>();
                  for (const roomBed of room.beds) {
                    const group = roomBed.bunkGroup?.trim();
                    if (group) {
                      bunkGroupCounts.set(
                        group,
                        (bunkGroupCounts.get(group) ?? 0) + 1,
                      );
                    }
                  }

                  return (
                    <div key={room.id} className="rounded-md border p-4">
                      <div className="grid gap-3 md:grid-cols-[2fr_90px_1fr_auto_auto]">
                        <Input
                          value={edit.name}
                          onChange={(event) =>
                            updateRoomEdit(room.id, { name: event.target.value })
                          }
                        />
                        <Input
                          type="number"
                          min="0"
                          value={edit.sortOrder}
                          onChange={(event) =>
                            updateRoomEdit(room.id, {
                              sortOrder: event.target.value,
                            })
                          }
                        />
                        <Textarea
                          value={edit.notes}
                          onChange={(event) =>
                            updateRoomEdit(room.id, { notes: event.target.value })
                          }
                          className="min-h-9"
                        />
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={edit.active}
                            onCheckedChange={(checked) =>
                              updateRoomEdit(room.id, {
                                active: checked === true,
                              })
                            }
                          />
                          Active
                        </label>
                        <div className="flex items-center gap-2">
                          {/* Fixed-width slot reserves space so the Save button
                              doesn't shift when the badge appears/disappears. */}
                          <span className="inline-flex min-w-[5rem] justify-end">
                            {isRoomDirty(room) ? (
                              <Badge
                                role="status"
                                aria-label="Unsaved changes"
                                variant="warning"
                                className="whitespace-nowrap"
                              >
                                Unsaved
                              </Badge>
                            ) : null}
                          </span>
                          <Button
                            variant="outline"
                            onClick={() => void saveRoom(room.id)}
                            disabled={saving === `room-${room.id}`}
                            className="gap-2"
                          >
                            <Save className="h-4 w-4" />
                            Save
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Delete room"
                            onClick={() => void deleteRoom(room.id)}
                            disabled={saving === `room-delete-${room.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      {deleteErrors[room.id] ? (
                        <p role="alert" className="mt-2 text-sm text-red-600">
                          {deleteErrors[room.id]}
                        </p>
                      ) : null}

                      <div className="mt-4 space-y-3">
                        <div className="grid gap-3 md:grid-cols-[2fr_90px_auto_auto_auto]">
                          <Input
                            placeholder="Bed name"
                            value={bedDraft.name}
                            onChange={(event) =>
                              updateBedDraft(room.id, {
                                name: event.target.value,
                              })
                            }
                          />
                          <Input
                            type="number"
                            min="0"
                            value={bedDraft.sortOrder}
                            onChange={(event) =>
                              updateBedDraft(room.id, {
                                sortOrder: event.target.value,
                              })
                            }
                          />
                          <select
                            aria-label="Bed type"
                            value={bedDraft.bedType}
                            onChange={(event) =>
                              updateBedDraft(room.id, {
                                bedType: event.target.value as BedTypeValue,
                              })
                            }
                            className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                          >
                            {BED_TYPE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                              checked={bedDraft.active}
                              onCheckedChange={(checked) =>
                                updateBedDraft(room.id, {
                                  active: checked === true,
                                })
                              }
                            />
                            Active
                          </label>
                          <Button
                            variant="outline"
                            onClick={() => void createBed(room.id)}
                            disabled={saving === `bed-new-${room.id}`}
                            className="gap-2"
                          >
                            <Plus className="h-4 w-4" />
                            Add Bed
                          </Button>
                        </div>

                        {isBunkTypeValue(bedDraft.bedType) ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              placeholder="Bunk group"
                              aria-label="Bunk group"
                              value={bedDraft.bunkGroup}
                              onChange={(event) =>
                                updateBedDraft(room.id, {
                                  bunkGroup: event.target.value,
                                })
                              }
                              className="w-36"
                            />
                            <BedTypeIndicator
                              bedType={bedDraft.bedType}
                              showLabel
                              labelOverride={bunkPairingLabel(
                                bedDraft.bedType,
                                bedDraft.bunkGroup,
                              )}
                            />
                            {!bedDraft.bunkGroup.trim() ? (
                              <span className="text-xs text-amber-600">
                                {BUNK_UNPAIRED_HINT}
                              </span>
                            ) : null}
                          </div>
                        ) : null}

                        {bedFormErrors[room.id] ? (
                          <p role="alert" className="text-sm text-red-600">
                            {bedFormErrors[room.id]}
                          </p>
                        ) : null}

                        {room.beds.length === 0 ? (
                          <div className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
                            No beds in this room.
                          </div>
                        ) : (
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Bed</TableHead>
                                <TableHead className="w-24">Sort</TableHead>
                                <TableHead className="w-24">Active</TableHead>
                                <TableHead className="w-48" />
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {room.beds.map((bed) => {
                                const bedEdit =
                                  bedEdits[bed.id] ?? bedEditFromBed(bed);
                                const bedGroup = bedEdit.bunkGroup.trim();
                                const bedIsBunk = isBunkTypeValue(
                                  bedEdit.bedType,
                                );
                                // Paired only when this bunk's group already
                                // holds two persisted beds; otherwise it is an
                                // unpaired bunk (no partner yet).
                                const bedPaired =
                                  bedIsBunk &&
                                  bedGroup !== "" &&
                                  (bunkGroupCounts.get(bedGroup) ?? 0) >= 2;

                                return (
                                  <TableRow key={bed.id}>
                                    <TableCell>
                                      <div className="space-y-2">
                                        <Input
                                          value={bedEdit.name}
                                          onChange={(event) =>
                                            updateBedEdit(bed.id, {
                                              name: event.target.value,
                                            })
                                          }
                                        />
                                        <div className="flex flex-wrap items-center gap-2">
                                          <select
                                            aria-label="Bed type"
                                            value={bedEdit.bedType}
                                            onChange={(event) =>
                                              updateBedEdit(bed.id, {
                                                bedType: event.target
                                                  .value as BedTypeValue,
                                              })
                                            }
                                            className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                                          >
                                            {BED_TYPE_OPTIONS.map((option) => (
                                              <option
                                                key={option.value}
                                                value={option.value}
                                              >
                                                {option.label}
                                              </option>
                                            ))}
                                          </select>
                                          {isBunkTypeValue(bedEdit.bedType) ? (
                                            <Input
                                              placeholder="Bunk group"
                                              aria-label="Bunk group"
                                              value={bedEdit.bunkGroup}
                                              onChange={(event) =>
                                                updateBedEdit(bed.id, {
                                                  bunkGroup: event.target.value,
                                                })
                                              }
                                              className="w-32"
                                            />
                                          ) : null}
                                          <BedTypeIndicator
                                            bedType={bedEdit.bedType}
                                            showLabel={bedIsBunk}
                                            labelOverride={
                                              bedPaired
                                                ? bunkPairingLabel(
                                                    bedEdit.bedType,
                                                    bedEdit.bunkGroup,
                                                  )
                                                : undefined
                                            }
                                            className="text-muted-foreground"
                                          />
                                        </div>
                                        {bedIsBunk && !bedPaired ? (
                                          <span className="text-xs text-amber-600">
                                            {BUNK_UNPAIRED_HINT}
                                          </span>
                                        ) : null}
                                        {bedEditErrors[bed.id] ? (
                                          <p
                                            role="alert"
                                            className="text-sm text-red-600"
                                          >
                                            {bedEditErrors[bed.id]}
                                          </p>
                                        ) : null}
                                      </div>
                                    </TableCell>
                                    <TableCell>
                                      <Input
                                        type="number"
                                        min="0"
                                        value={bedEdit.sortOrder}
                                        onChange={(event) =>
                                          updateBedEdit(bed.id, {
                                            sortOrder: event.target.value,
                                          })
                                        }
                                      />
                                    </TableCell>
                                    <TableCell>
                                      <Checkbox
                                        checked={bedEdit.active}
                                        onCheckedChange={(checked) =>
                                          updateBedEdit(bed.id, {
                                            active: checked === true,
                                          })
                                        }
                                      />
                                    </TableCell>
                                    <TableCell>
                                      <div className="flex items-center gap-2">
                                        {/* Fixed-width slot keeps the Save
                                            button from shifting with the badge. */}
                                        <span className="inline-flex min-w-[5rem] justify-end">
                                          {isBedDirty(bed) ? (
                                            <Badge
                                              role="status"
                                              aria-label="Unsaved changes"
                                              variant="warning"
                                              className="whitespace-nowrap"
                                            >
                                              Unsaved
                                            </Badge>
                                          ) : null}
                                        </span>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => void saveBed(bed.id)}
                                          disabled={saving === `bed-${bed.id}`}
                                        >
                                          Save
                                        </Button>
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          aria-label="Delete bed"
                                          onClick={() => void deleteBed(bed.id)}
                                          disabled={
                                            saving === `bed-delete-${bed.id}`
                                          }
                                        >
                                          <Trash2 className="h-4 w-4" />
                                        </Button>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
