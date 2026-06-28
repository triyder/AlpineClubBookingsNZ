import type { BedOption, DashboardAllocation, DashboardPayload } from "./types";

export interface AllocationMoveTarget {
  bedId: string;
  stayDate: string;
}

export type AllocationMovePlan =
  | { type: "noop" }
  | {
      type: "single";
      allocationId: string;
      stayDate: string;
    }
  | {
      type: "bulk";
      allocationIds: string[];
      bookingGuestId: string;
      stayDates: string[];
    }
  | {
      type: "blocked-date-shift";
      firstStayDate: string;
      targetStayDate: string;
    };

export function planAllocationMove(input: {
  allocation: DashboardAllocation;
  target: AllocationMoveTarget;
  visibleAllocations: DashboardAllocation[];
  visibleNights: string[];
}): AllocationMovePlan {
  const { allocation, target, visibleAllocations, visibleNights } = input;

  if (!visibleNights.includes(target.stayDate)) {
    return { type: "noop" };
  }

  if (
    target.bedId === allocation.bedId &&
    target.stayDate === allocation.stayDate
  ) {
    return { type: "noop" };
  }

  const guestAllocations = visibleAllocations
    .filter((item) => item.bookingGuestId === allocation.bookingGuestId)
    .sort(
      (a, b) =>
        a.stayDate.localeCompare(b.stayDate) || a.id.localeCompare(b.id),
    );

  const firstAllocation = guestAllocations[0];
  const isFirstVisibleAllocation = firstAllocation?.id === allocation.id;

  if (!isFirstVisibleAllocation) {
    return {
      type: "single",
      allocationId: allocation.id,
      stayDate: target.stayDate,
    };
  }

  if (target.stayDate !== allocation.stayDate) {
    return {
      type: "blocked-date-shift",
      firstStayDate: allocation.stayDate,
      targetStayDate: target.stayDate,
    };
  }

  if (guestAllocations.length <= 1) {
    return {
      type: "single",
      allocationId: allocation.id,
      stayDate: target.stayDate,
    };
  }

  return {
    type: "bulk",
    allocationIds: guestAllocations.map((item) => item.id),
    bookingGuestId: allocation.bookingGuestId,
    stayDates: guestAllocations.map((item) => item.stayDate),
  };
}

export function applyOptimisticAllocationBedMove(input: {
  payload: DashboardPayload;
  allocationIds: string[];
  bed: BedOption;
}): DashboardPayload {
  const allocationIdSet = new Set(input.allocationIds);

  return {
    ...input.payload,
    allocations: input.payload.allocations.map((allocation) =>
      allocationIdSet.has(allocation.id)
        ? {
            ...allocation,
            bedId: input.bed.id,
            bedName: input.bed.bedName,
            roomId: input.bed.roomId,
            roomName: input.bed.roomName,
            source: "MANUAL",
            approvedAt: null,
            approvedByName: null,
          }
        : allocation,
    ),
  };
}
