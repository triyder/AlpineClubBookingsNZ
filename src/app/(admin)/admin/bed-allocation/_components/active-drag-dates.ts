import type {
  BucketGuestGroup,
  DashboardAllocation,
  DragData,
} from "./types";

export function deriveActiveDragDates(input: {
  activeDrag: DragData | null;
  visibleAllocations: DashboardAllocation[];
  bucketGroups: BucketGuestGroup[];
}): string[] {
  const { activeDrag, visibleAllocations, bucketGroups } = input;
  if (!activeDrag) return [];

  if (activeDrag.type === "bucket-guest") {
    return [
      ...new Set(
        bucketGroups
          .find((group) => group.bookingGuestId === activeDrag.bookingGuestId)
          ?.stayDates ?? [],
      ),
    ].sort();
  }

  const allocation = visibleAllocations.find(
    (item) => item.id === activeDrag.allocationId,
  );
  if (!allocation) return [];

  const guestAllocations = visibleAllocations
    .filter((item) => item.bookingGuestId === allocation.bookingGuestId)
    .sort(
      (left, right) =>
        left.stayDate.localeCompare(right.stayDate) ||
        left.id.localeCompare(right.id),
    );

  const firstAllocation = guestAllocations[0];
  if (firstAllocation?.id === allocation.id && guestAllocations.length > 1) {
    return [...new Set(guestAllocations.map((item) => item.stayDate))].sort();
  }

  return [allocation.stayDate];
}
