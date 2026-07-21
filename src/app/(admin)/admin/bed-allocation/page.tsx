"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LodgeSelect, useLodgeOptions } from "@/components/lodge-select";
import { useSearchParams } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  BedDouble,
  Check,
  RefreshCw,
  Save,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import {
  applyOptimisticAllocationBedMove,
  planAllocationMove,
} from "./_components/allocation-move";
import { BucketBoard } from "./_components/bucket-board";
import { RoomTable } from "./_components/room-table";
import {
  type BedOption,
  type BedOptionGroup,
  type BucketGuestGroup,
  type BulkAllocationConflict,
  type DashboardAllocation,
  type DashboardGuestNight,
  type DashboardPayload,
  type DragData,
  type DropData,
} from "./_components/types";
import { deriveActiveDragDates } from "./_components/active-drag-dates";
import { useSyncedScroll } from "./_components/use-synced-scroll";

// Mirrors MAX_BED_ALLOCATION_RANGE_NIGHTS in src/lib/admin-bed-allocation.ts.
const MAX_RANGE_NIGHTS = 31;

function todayDateOnly() {
  return formatDateOnly(getTodayDateOnly());
}

function clampRange(from: string, to: string): string {
  if (!isDateOnlyString(from) || !isDateOnlyString(to)) return to;

  const fromDate = parseDateOnly(from);
  let toDate = parseDateOnly(to);
  if (toDate <= fromDate) {
    toDate = addDaysDateOnly(fromDate, 1);
  }

  const maxTo = addDaysDateOnly(fromDate, MAX_RANGE_NIGHTS);
  if (toDate > maxTo) {
    toDate = maxTo;
  }

  return formatDateOnly(toDate);
}

async function readApiError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

function buildBucketGroups(
  unallocatedGuestNights: DashboardGuestNight[],
): BucketGuestGroup[] {
  const groups = new Map<string, BucketGuestGroup>();

  for (const guestNight of unallocatedGuestNights) {
    const existing = groups.get(guestNight.bookingGuestId);
    if (existing) {
      existing.stayDates.push(guestNight.stayDate);
      continue;
    }

    groups.set(guestNight.bookingGuestId, {
      bookingGuestId: guestNight.bookingGuestId,
      bookingId: guestNight.bookingId,
      guestName: guestNight.guestName,
      guestAgeTier: guestNight.guestAgeTier,
      memberName: guestNight.memberName,
      stayDates: [guestNight.stayDate],
    });
  }

  for (const group of groups.values()) {
    group.stayDates.sort();
  }

  return [...groups.values()];
}

function removeUnallocatedNights(
  payload: DashboardPayload,
  bookingGuestId: string,
  stayDates: string[],
): DashboardPayload {
  const stayDateSet = new Set(stayDates);
  return {
    ...payload,
    unallocatedGuestNights: payload.unallocatedGuestNights.filter(
      (guestNight) =>
        !(
          guestNight.bookingGuestId === bookingGuestId &&
          stayDateSet.has(guestNight.stayDate)
        ),
    ),
  };
}

function addOptimisticAllocations(
  payload: DashboardPayload,
  group: {
    bookingGuestId: string;
    bookingId: string;
    guestName: string;
    guestAgeTier: string;
  },
  bed: BedOption,
  stayDates: string[],
): DashboardPayload {
  const existingDates = new Set(
    payload.allocations
      .filter((allocation) => allocation.bookingGuestId === group.bookingGuestId)
      .map((allocation) => allocation.stayDate),
  );

  // Mirror the booking's real status and capacity-holding flag so the optimistic
  // chip picks the correct Held/Provisional state (#1251, #1254). The fallbacks
  // render as provisional and are corrected by the next loadDashboard().
  const sourceBooking = payload.bookings.find(
    (booking) => booking.id === group.bookingId,
  );
  const bookingStatus = sourceBooking?.status ?? "";
  const holdsCapacity = sourceBooking?.holdsCapacity ?? false;

  const newAllocations: DashboardAllocation[] = stayDates
    .filter((stayDate) => !existingDates.has(stayDate))
    .map((stayDate) => ({
      id: `optimistic:${group.bookingGuestId}:${stayDate}`,
      bookingId: group.bookingId,
      bookingGuestId: group.bookingGuestId,
      guestName: group.guestName,
      guestAgeTier: group.guestAgeTier,
      roomId: bed.roomId,
      roomName: bed.roomName,
      bedId: bed.id,
      bedName: bed.bedName,
      stayDate,
      source: "MANUAL",
      approvedAt: null,
      approvedByName: null,
      bookingStatus,
      holdsCapacity,
      // Optimistic drops render as a primary occupant; the server decides
      // second-occupant sharing and the next loadDashboard() corrects it (#1701).
      isSecondOccupant: false,
    }));

  return {
    ...payload,
    allocations: [...payload.allocations, ...newAllocations],
  };
}

function applyOptimisticMove(
  payload: DashboardPayload,
  allocationId: string,
  bed: BedOption,
  stayDate: string,
): DashboardPayload {
  return {
    ...payload,
    allocations: payload.allocations.map((allocation) =>
      allocation.id === allocationId
        ? {
            ...allocation,
            bedId: bed.id,
            bedName: bed.bedName,
            roomId: bed.roomId,
            roomName: bed.roomName,
            stayDate,
            source: "MANUAL",
            approvedAt: null,
            approvedByName: null,
          }
        : allocation,
    ),
  };
}

function applyOptimisticRemove(
  payload: DashboardPayload,
  allocation: DashboardAllocation,
): DashboardPayload {
  const memberName =
    payload.bookings.find((booking) => booking.id === allocation.bookingId)
      ?.memberName ?? "";

  return {
    ...payload,
    allocations: payload.allocations.filter((item) => item.id !== allocation.id),
    unallocatedGuestNights: [
      ...payload.unallocatedGuestNights,
      {
        bookingId: allocation.bookingId,
        bookingGuestId: allocation.bookingGuestId,
        guestName: allocation.guestName,
        guestAgeTier: allocation.guestAgeTier,
        memberName,
        stayDate: allocation.stayDate,
      },
    ],
  };
}

export default function AdminBedAllocationPage() {
  const searchParams = useSearchParams();
  const requestedFrom = searchParams.get("from");
  const requestedTo = searchParams.get("to");
  const highlightedBookingId = searchParams.get("bookingId") || "";
  const canEditBookings = useAdminAreaEditAccess("bookings");

  const initialFrom = isDateOnlyString(requestedFrom ?? "")
    ? (requestedFrom as string)
    : todayDateOnly();

  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(() =>
    isDateOnlyString(requestedTo ?? "")
      ? clampRange(initialFrom, requestedTo as string)
      : clampRange(initialFrom, formatDateOnly(addDaysDateOnly(parseDateOnly(initialFrom), 7))),
  );

  // Board lodge scope (ADR-003); LodgeSelect renders nothing (and reports
  // the sole lodge) while fewer than two lodges exist (ADR-002). Initialised
  // from the URL synchronously so the first dashboard fetch is already
  // lodge-filtered.
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin");
  const [lodgeId, setLodgeId] = useState<string | null>(
    searchParams.get("lodgeId"),
  );

  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [autoAllocationEnabled, setAutoAllocationEnabled] = useState(true);
  const [singleNightMode, setSingleNightMode] = useState(false);
  const [selectedBeds, setSelectedBeds] = useState<Record<string, string>>({});
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragData, setActiveDragData] = useState<DragData | null>(null);
  const registerBoardScroller = useSyncedScroll();
  // Tracks the focused booking id we have already snapped the date window onto,
  // so we snap exactly once (#1302) and never fight an admin who later moves the
  // window off the focused booking.
  const snappedBookingIdRef = useRef<string | null>(null);

  const nights = useMemo(() => {
    if (!isDateOnlyString(fromDate) || !isDateOnlyString(toDate)) return [];
    return eachDateOnlyInRange(parseDateOnly(fromDate), parseDateOnly(toDate)).map(
      formatDateOnly,
    );
  }, [fromDate, toDate]);

  const bedOptionGroups = useMemo<BedOptionGroup[]>(() => {
    return [...(payload?.rooms ?? [])]
      .filter((room) => room.active)
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((room) => ({
        roomId: room.id,
        roomName: room.name,
        beds: [...room.beds]
          .filter((bed) => bed.active)
          .sort((left, right) => left.sortOrder - right.sortOrder)
          .map((bed) => ({
            id: bed.id,
            roomId: room.id,
            roomName: room.name,
            bedName: bed.name,
            label: `${room.name} / ${bed.name}`,
          })),
      }))
      .filter((group) => group.beds.length > 0);
  }, [payload]);

  const bedOptions = useMemo(
    () => bedOptionGroups.flatMap((group) => group.beds),
    [bedOptionGroups],
  );

  const bedById = useMemo(() => {
    const map = new Map<string, BedOption>();
    for (const bed of bedOptions) {
      map.set(bed.id, bed);
    }
    return map;
  }, [bedOptions]);

  const activeRooms = useMemo(
    () =>
      [...(payload?.rooms ?? [])]
        .filter((room) => room.active)
        .sort((left, right) => left.sortOrder - right.sortOrder),
    [payload],
  );

  const allocationByBedAndDate = useMemo(() => {
    // #1701: a DOUBLE bed-night may hold two occupants (declared partners), so
    // each cell key maps to an array. Keep the primary occupant first so a
    // shared double renders predictably.
    const map = new Map<string, DashboardAllocation[]>();
    for (const allocation of payload?.allocations ?? []) {
      const key = `${allocation.bedId}:${allocation.stayDate}`;
      const existing = map.get(key);
      if (existing) {
        existing.push(allocation);
        existing.sort(
          (left, right) =>
            Number(left.isSecondOccupant) - Number(right.isSecondOccupant),
        );
      } else {
        map.set(key, [allocation]);
      }
    }
    return map;
  }, [payload]);

  const allocationsById = useMemo(() => {
    const map = new Map<string, DashboardAllocation>();
    for (const allocation of payload?.allocations ?? []) {
      map.set(allocation.id, allocation);
    }
    return map;
  }, [payload]);

  const bucketGroups = useMemo(
    () => buildBucketGroups(payload?.unallocatedGuestNights ?? []),
    [payload],
  );

  const bucketGroupsByGuest = useMemo(
    () => new Map(bucketGroups.map((group) => [group.bookingGuestId, group])),
    [bucketGroups],
  );

  const groupsByBooking = useMemo(() => {
    const map = new Map<string, BucketGuestGroup[]>();
    for (const group of bucketGroups) {
      const list = map.get(group.bookingId) ?? [];
      list.push(group);
      map.set(group.bookingId, list);
    }
    return map;
  }, [bucketGroups]);

  const activeDragLabel = useMemo(() => {
    if (!activeDragId) return null;
    if (activeDragId.startsWith("bucket-guest:")) {
      const id = activeDragId.slice("bucket-guest:".length);
      return bucketGroupsByGuest.get(id)?.guestName ?? null;
    }
    if (activeDragId.startsWith("allocation:")) {
      const id = activeDragId.slice("allocation:".length);
      return allocationsById.get(id)?.guestName ?? null;
    }
    return null;
  }, [activeDragId, bucketGroupsByGuest, allocationsById]);

  const activeDragDates = useMemo(() => {
    return new Set(
      deriveActiveDragDates({
        activeDrag: activeDragData,
        visibleAllocations: payload?.allocations ?? [],
        bucketGroups,
      }),
    );
  }, [activeDragData, payload?.allocations, bucketGroups]);

  async function loadDashboard() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      if (lodgeId) params.set("lodgeId", lodgeId);
      if (highlightedBookingId) {
        params.set("bookingId", highlightedBookingId);
      }
      const response = await fetch(`/api/admin/bed-allocation?${params}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Failed to load bed allocation"),
        );
      }

      const data = (await response.json()) as DashboardPayload;
      setPayload(data);
      setAutoAllocationEnabled(data.settings.autoAllocationEnabled);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to load bed allocation",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate, lodgeId]);

  // Snap the date window onto a deep-linked focused booking that loaded outside
  // the current range (#1302). The server returns its stay window only while it
  // is out of range, so this fires at most once per booking; the ref guards a
  // re-snap after the follow-up load (or after the admin browses away).
  useEffect(() => {
    const focused = payload?.focusedBooking;
    if (!focused || focused.id !== highlightedBookingId) return;
    if (snappedBookingIdRef.current === focused.id) return;
    snappedBookingIdRef.current = focused.id;
    setFromDate(focused.checkIn);
    setToDate(clampRange(focused.checkIn, focused.checkOut));
  }, [payload, highlightedBookingId]);

  async function withPending<T>(
    keys: string | string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    setPendingKeys((prev) => {
      const next = new Set(prev);
      for (const key of keyList) {
        next.add(key);
      }
      return next;
    });
    try {
      return await fn();
    } finally {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        for (const key of keyList) {
          next.delete(key);
        }
        return next;
      });
    }
  }

  async function mutate(
    label: string,
    request: () => Promise<Response>,
    success: string,
  ) {
    setSaving(label);
    try {
      const response = await request();
      if (!response.ok) {
        throw new Error(await readApiError(response, "Request failed"));
      }
      toast.success(success);
      await loadDashboard();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed");
    } finally {
      setSaving(null);
    }
  }

  async function saveSettings() {
    if (!canEditBookings) return;

    await mutate(
      "settings",
      () =>
        fetch("/api/admin/bed-allocation/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            autoAllocationEnabled,
            ...(lodgeId ? { lodgeId } : {}),
          }),
        }),
      "Bed allocation mode saved",
    );
  }

  async function runAutoAllocation() {
    if (!canEditBookings) return;

    await mutate(
      "auto",
      () =>
        fetch("/api/admin/bed-allocation/auto-allocate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromDate,
            to: toDate,
            ...(lodgeId ? { lodgeId } : {}),
          }),
        }),
      "Auto allocation applied",
    );
  }

  async function approveVisible() {
    if (!canEditBookings) return;

    await mutate(
      "approve",
      () =>
        fetch("/api/admin/bed-allocation/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromDate,
            to: toDate,
            ...(lodgeId ? { lodgeId } : {}),
          }),
        }),
      "Allocations approved",
    );
  }

  async function allocateFullStay(group: BucketGuestGroup, bedId: string) {
    if (!canEditBookings) return;

    const bed = bedById.get(bedId);
    if (!bed || !payload) return;

    const snapshot = payload;
    setPayload(
      addOptimisticAllocations(
        removeUnallocatedNights(payload, group.bookingGuestId, group.stayDates),
        group,
        bed,
        group.stayDates,
      ),
    );

    await withPending(`guest:${group.bookingGuestId}`, async () => {
      try {
        const response = await fetch("/api/admin/bed-allocation/allocations/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingGuestId: group.bookingGuestId,
            bedId,
            stayDates: group.stayDates,
          }),
        });

        if (!response.ok) {
          setPayload(snapshot);
          toast.error(await readApiError(response, "Failed to allocate bed"));
          await loadDashboard();
          return;
        }

        const data = (await response.json()) as {
          conflicts: BulkAllocationConflict[];
        };

        if (data.conflicts.length > 0) {
          toast.warning(
            `${group.guestName}: that bed was just taken for ${data.conflicts
              .map((conflict) => conflict.stayDate)
              .join(", ")} — refreshing the board`,
          );
        } else {
          toast.success("Allocation saved");
        }
        await loadDashboard();
      } catch {
        setPayload(snapshot);
        toast.error("Failed to allocate bed");
        await loadDashboard();
      }
    });
  }

  async function allocateSingleNight(
    group: BucketGuestGroup,
    bedId: string,
    stayDate: string,
  ) {
    if (!canEditBookings) return;

    if (!group.stayDates.includes(stayDate)) {
      toast.error(`${group.guestName} is not staying on ${stayDate}`);
      return;
    }

    const bed = bedById.get(bedId);
    if (!bed || !payload) return;

    const snapshot = payload;
    setPayload(
      addOptimisticAllocations(
        removeUnallocatedNights(payload, group.bookingGuestId, [stayDate]),
        group,
        bed,
        [stayDate],
      ),
    );

    await withPending(`guest:${group.bookingGuestId}`, async () => {
      try {
        const response = await fetch("/api/admin/bed-allocation/allocations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingGuestId: group.bookingGuestId,
            bedId,
            stayDate,
          }),
        });

        if (!response.ok) {
          setPayload(snapshot);
          if (response.status === 409) {
            toast.warning(
              `That bed was just taken for ${stayDate} — refreshing the board`,
            );
          } else {
            toast.error(await readApiError(response, "Failed to allocate bed"));
          }
          await loadDashboard();
          return;
        }

        toast.success("Allocation saved");
        await loadDashboard();
      } catch {
        setPayload(snapshot);
        toast.error("Failed to allocate bed");
        await loadDashboard();
      }
    });
  }

  async function moveAllocation(
    allocation: DashboardAllocation,
    target: { bedId: string; roomId: string; stayDate: string },
  ) {
    if (!canEditBookings) return;

    if (!payload) return;
    const bed = bedById.get(target.bedId);
    if (!bed) return;

    const movePlan = planAllocationMove({
      allocation,
      target,
      visibleAllocations: payload.allocations,
      visibleNights: nights,
    });

    if (movePlan.type === "noop") {
      return;
    }

    if (movePlan.type === "blocked-date-shift") {
      toast.info(
        `First-night moves keep guest dates unchanged. Drop ${movePlan.firstStayDate} onto another bed in the same date column.`,
      );
      return;
    }

    const snapshot = payload;

    if (movePlan.type === "bulk") {
      setPayload(
        applyOptimisticAllocationBedMove({
          payload,
          allocationIds: movePlan.allocationIds,
          bed,
        }),
      );

      await withPending(
        movePlan.allocationIds.map((id) => `allocation:${id}`),
        async () => {
          try {
            const response = await fetch(
              "/api/admin/bed-allocation/allocations/bulk",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  bookingGuestId: movePlan.bookingGuestId,
                  bedId: target.bedId,
                  stayDates: movePlan.stayDates,
                }),
              },
            );

            if (!response.ok) {
              setPayload(snapshot);
              toast.error(
                await readApiError(response, "Failed to move allocations"),
              );
              await loadDashboard();
              return;
            }

            const data = (await response.json()) as {
              conflicts: BulkAllocationConflict[];
            };

            if (data.conflicts.length > 0) {
              toast.warning(
                `${allocation.guestName}: that bed was just taken for ${data.conflicts
                  .map((conflict) => conflict.stayDate)
                  .join(", ")}, refreshing the board`,
              );
            } else {
              toast.success("Visible guest nights moved");
            }
            await loadDashboard();
          } catch {
            setPayload(snapshot);
            toast.error("Failed to move allocations");
            await loadDashboard();
          }
        },
      );
      return;
    }

    setPayload(applyOptimisticMove(payload, allocation.id, bed, target.stayDate));

    await withPending(`allocation:${allocation.id}`, async () => {
      try {
        const postResponse = await fetch("/api/admin/bed-allocation/allocations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingGuestId: allocation.bookingGuestId,
            bedId: target.bedId,
            stayDate: target.stayDate,
          }),
        });

        if (!postResponse.ok) {
          setPayload(snapshot);
          if (postResponse.status === 409) {
            toast.warning(
              `That bed was just taken for ${target.stayDate} — refreshing the board`,
            );
          } else {
            toast.error(await readApiError(postResponse, "Failed to move allocation"));
          }
          await loadDashboard();
          return;
        }

        if (target.stayDate !== allocation.stayDate) {
          const deleteResponse = await fetch(
            `/api/admin/bed-allocation/allocations/${allocation.id}`,
            { method: "DELETE" },
          );
          if (!deleteResponse.ok) {
            toast.error(
              "Allocation moved, but the original night could not be cleared — refreshing the board",
            );
            await loadDashboard();
            return;
          }
        }

        toast.success("Allocation moved");
        await loadDashboard();
      } catch {
        setPayload(snapshot);
        toast.error("Failed to move allocation");
        await loadDashboard();
      }
    });
  }

  async function removeAllocation(allocation: DashboardAllocation) {
    if (!canEditBookings) return;

    if (!payload) return;

    const snapshot = payload;
    setPayload(applyOptimisticRemove(payload, allocation));

    await withPending(`allocation:${allocation.id}`, async () => {
      try {
        const response = await fetch(
          `/api/admin/bed-allocation/allocations/${allocation.id}`,
          { method: "DELETE" },
        );

        if (!response.ok) {
          setPayload(snapshot);
          toast.error(await readApiError(response, "Failed to remove allocation"));
          await loadDashboard();
          return;
        }

        toast.success("Allocation removed");
        await loadDashboard();
      } catch {
        setPayload(snapshot);
        toast.error("Failed to remove allocation");
        await loadDashboard();
      }
    });
  }

  function handleDragStart(event: DragStartEvent) {
    if (!canEditBookings) return;

    setActiveDragId(String(event.active.id));
    setActiveDragData((event.active.data.current as DragData | undefined) ?? null);
  }

  function handleDragCancel() {
    setActiveDragId(null);
    setActiveDragData(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    setActiveDragData(null);
    if (!canEditBookings) return;

    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current as DragData | undefined;
    const overData = over.data.current as DropData | undefined;
    if (!activeData || !overData) return;

    if (activeData.type === "bucket-guest") {
      if (overData.type !== "cell") return;
      const group = bucketGroupsByGuest.get(activeData.bookingGuestId);
      if (!group) return;

      if (singleNightMode) {
        void allocateSingleNight(group, overData.bedId, overData.stayDate);
      } else {
        void allocateFullStay(group, overData.bedId);
      }
    } else if (activeData.type === "allocation") {
      const allocation = allocationsById.get(activeData.allocationId);
      if (!allocation) return;

      if (overData.type === "bucket") {
        void removeAllocation(allocation);
      } else if (overData.type === "cell") {
        void moveAllocation(allocation, {
          bedId: overData.bedId,
          roomId: overData.roomId,
          stayDate: overData.stayDate,
        });
      }
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const pendingGuestIds = useMemo(() => {
    const ids = new Set<string>();
    for (const key of pendingKeys) {
      if (key.startsWith("guest:")) ids.add(key.slice("guest:".length));
    }
    return ids;
  }, [pendingKeys]);

  const pendingAllocationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const key of pendingKeys) {
      if (key.startsWith("allocation:")) ids.add(key.slice("allocation:".length));
    }
    return ids;
  }, [pendingKeys]);

  const unapprovedCount =
    payload?.allocations.filter((allocation) => !allocation.approvedAt).length ?? 0;
  const activeBedCount = bedOptions.length;

  // A focused booking is "on the board" when it has a bucket card or a placed
  // allocation in the current range (#1302).
  const focusedBookingVisible =
    highlightedBookingId !== "" &&
    ((payload?.bookings.some((booking) => booking.id === highlightedBookingId) ??
      false) ||
      (payload?.allocations.some(
        (allocation) => allocation.bookingId === highlightedBookingId,
      ) ??
        false));

  // Residual case: a booking is focused but neither visible nor snappable (the
  // server returned no stay window — e.g. it was cancelled or removed). The snap
  // effect handles every allocatable out-of-range booking, so this only guides
  // the admin when snapping is genuinely impossible.
  const showFocusedBookingUnavailable =
    highlightedBookingId !== "" &&
    payload !== null &&
    !focusedBookingVisible &&
    payload.focusedBooking === null;

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEditBookings} className="mb-6">
      Your admin role can view bed allocation but cannot move, allocate,
      approve, or save assignments.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Bed Allocation</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant={autoAllocationEnabled ? "success" : "outline"}>
              {autoAllocationEnabled ? "Auto allocation" : "Admin only"}
            </Badge>
            {payload ? (
              <>
                <Badge variant="secondary">{payload.rooms.length} rooms</Badge>
                <Badge variant="secondary">{activeBedCount} active beds</Badge>
                <Badge variant="secondary">
                  {payload.allocations.length} allocations
                </Badge>
                {highlightedBookingId ? (
                  <Badge variant="warning">Focused booking</Badge>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,200px)_minmax(0,150px)_minmax(0,150px)_auto]">
          <LodgeSelect
            lodges={lodges}
            value={lodgeId}
            onChange={setLodgeId}
            loading={lodgesLoading}
          />
          <div className="space-y-1">
            <Label htmlFor="bed-from">Date In</Label>
            <Input
              id="bed-from"
              type="date"
              value={fromDate}
              onChange={(event) => {
                const value = event.target.value;
                if (!isDateOnlyString(value)) return;
                setFromDate(value);
                setToDate((current) => clampRange(value, current));
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bed-to">Date Out</Label>
            <Input
              id="bed-to"
              type="date"
              value={toDate}
              onChange={(event) => {
                const value = event.target.value;
                if (!isDateOnlyString(value)) return;
                setToDate(clampRange(fromDate, value));
              }}
            />
          </div>
          <Button
            variant="outline"
            onClick={() => void loadDashboard()}
            disabled={loading}
            className="gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        The board shows up to {MAX_RANGE_NIGHTS} nights at a time.
      </p>

      {showFocusedBookingUnavailable ? (
        <Alert variant="warning">
          Focused booking is not on the board — it may be cancelled or removed.
          Adjust Date In / Date Out to browse the board.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BedDouble className="h-4 w-4" />
            Allocation Mode
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
            <label className="flex items-center gap-3 text-sm font-medium">
              <Checkbox
                checked={autoAllocationEnabled}
                disabled={!canEditBookings}
                onCheckedChange={(checked) =>
                  setAutoAllocationEnabled(checked === true)
                }
              />
              Auto allocation enabled
            </label>
            <label className="flex items-center gap-3 text-sm font-medium">
              <Checkbox
                checked={singleNightMode}
                onCheckedChange={(checked) => setSingleNightMode(checked === true)}
              />
              Single-night drag mode
            </label>
          </div>
          <ViewOnlyActionButton
            canEdit={canEditBookings}
            describeReason={false}
            onClick={() => void saveSettings()}
            disabled={saving === "settings"}
            className="gap-2 md:w-auto"
          >
            <Save className="h-4 w-4" />
            Save Mode
          </ViewOnlyActionButton>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border bg-card p-6 text-sm text-muted-foreground">
          <Spinner size="sm" label="Loading bed allocation" />
          <span aria-hidden="true">Loading bed allocation</span>
        </div>
      ) : null}

      {payload ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          {payload.exclusiveHolds.length > 0 ? (
            <Alert
              variant="info"
              title="Exclusive whole-lodge hold — no per-bed allocation needed"
            >
              <p className="mb-1">
                {payload.exclusiveHolds.length === 1
                  ? "This booking holds the whole lodge for its nights"
                  : "These bookings hold the whole lodge for their nights"}
                , so its guests are not placed on individual beds. The lodge is
                taken.
              </p>
              <ul className="space-y-1">
                {payload.exclusiveHolds.map((hold) => (
                  <li key={hold.bookingId}>
                    <span className="font-medium">{hold.memberName}</span> ·{" "}
                    <span className="font-mono text-xs">{hold.bookingId}</span> ·{" "}
                    {hold.checkIn} → {hold.checkOut} · {hold.guestCount} guest
                    {hold.guestCount === 1 ? "" : "s"}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Bookings approved, awaiting allocation
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-3">
                <ViewOnlyActionButton
                  canEdit={canEditBookings}
                  describeReason={false}
                  onClick={() => void runAutoAllocation()}
                  disabled={
                    !payload.settings.autoAllocationEnabled ||
                    payload.suggestedAllocations.length === 0 ||
                    saving === "auto"
                  }
                  className="gap-2"
                >
                  <Wand2 className="h-4 w-4" />
                  Run Auto Allocation
                </ViewOnlyActionButton>
                <ViewOnlyActionButton
                  canEdit={canEditBookings}
                  describeReason={false}
                  variant="outline"
                  onClick={() => void approveVisible()}
                  disabled={unapprovedCount === 0 || saving === "approve"}
                  className="gap-2"
                >
                  <Check className="h-4 w-4" />
                  Approve Visible
                </ViewOnlyActionButton>
                <Badge variant="outline">
                  {payload.suggestedAllocations.length} suggested
                </Badge>
                <Badge
                  variant={unapprovedCount > 0 ? "warning" : "success"}
                  title="Draft bed placements on the Allocation Board below that still need approving — distinct from bookings still awaiting a bed."
                >
                  {unapprovedCount} draft allocations to approve
                </Badge>
              </div>

              {payload.warnings.length > 0 ? (
                <Alert variant="warning" title="Warnings">
                  <ul className="space-y-1">
                    {payload.warnings.map((warning) => (
                      <li key={warning.id}>{warning.message}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}

              <BucketBoard
                bookings={payload.bookings}
                groupsByBooking={groupsByBooking}
                bedOptions={bedOptions}
                bedOptionGroups={bedOptionGroups}
                selectedBeds={selectedBeds}
                onSelectBed={(bookingGuestId, bedId) =>
                  setSelectedBeds((current) => ({
                    ...current,
                    [bookingGuestId]: bedId,
                  }))
                }
                onAllocate={(group) => {
                  const bedId = selectedBeds[group.bookingGuestId];
                  if (!bedId || bedId === "none") {
                    toast.error("Select a bed first");
                    return;
                  }
                  void allocateFullStay(group, bedId);
                }}
                pendingGuestIds={pendingGuestIds}
                highlightedBookingId={highlightedBookingId}
                canEdit={canEditBookings}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Allocation Board</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {payload.rooms.length === 0 ? (
                <EmptyState
                  icon={BedDouble}
                  title="No rooms available"
                  description="Set up rooms and beds before allocating."
                  className="rounded-md border border-dashed"
                />
              ) : null}

              {activeBedCount === 0 && payload.rooms.length > 0 ? (
                <Alert variant="warning">No active beds available.</Alert>
              ) : null}

              {activeRooms.map((room) => (
                <RoomTable
                  key={room.id}
                  room={room}
                  nights={nights}
                  allocationByBedAndDate={allocationByBedAndDate}
                  bedOptions={bedOptions}
                  bedOptionGroups={bedOptionGroups}
                  onReassignBed={(allocation, bedId) =>
                    void moveAllocation(allocation, {
                      bedId,
                      roomId: bedById.get(bedId)?.roomId ?? allocation.roomId,
                      stayDate: allocation.stayDate,
                    })
                  }
                  onRemove={(allocation) => void removeAllocation(allocation)}
                  pendingAllocationIds={pendingAllocationIds}
                  highlightedBookingId={highlightedBookingId}
                  activeDragDates={activeDragDates}
                  registerScroller={registerBoardScroller}
                  canEdit={canEditBookings}
                />
              ))}
            </CardContent>
          </Card>

          <DragOverlay>
            {activeDragLabel ? (
              <div className="rounded-md border bg-card px-3 py-2 text-sm font-medium text-card-foreground shadow-lg">
                {activeDragLabel}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : null}
      </div>
    </div>
  );
}
