interface DashboardBed {
  id: string;
  roomId: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface DashboardRoom {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  notes: string | null;
  beds: DashboardBed[];
}

export interface DashboardAllocation {
  id: string;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: string;
  roomId: string;
  roomName: string;
  bedId: string;
  bedName: string;
  stayDate: string;
  source: "AUTO" | "MANUAL";
  approvedAt: string | null;
  approvedByName: string | null;
  // Raw booking status (#1251), kept for display/debugging.
  bookingStatus: string;
  // Server-computed "does this booking hold capacity" flag (#1254). Because
  // holding is no longer a pure function of status (an accepted-but-unpaid quote
  // is PENDING but holds), the board reads this precomputed flag —
  // bookingHoldsCapacity() — for the "Held" vs "Provisional" badge.
  holdsCapacity: boolean;
}

export interface DashboardGuestNight {
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: string;
  memberName: string;
  stayDate: string;
}

interface DashboardRequestedRoom {
  id: string;
  name: string;
  active: boolean;
}

export interface DashboardBookingSummary {
  id: string;
  status: string;
  // Server-computed capacity-holding flag (#1254); see DashboardAllocation.
  holdsCapacity: boolean;
  createdAt: string;
  checkIn: string;
  checkOut: string;
  memberName: string;
  // Preferred room requested at booking time (#706). Inactive rooms are
  // surfaced as a warning chip rather than treated as a preference.
  requestedRoom: DashboardRequestedRoom | null;
  // Split-booking group link (#738). Set on the provisional non-member child;
  // null on the member booking and on un-split bookings.
  parentBookingId: string | null;
}

interface DashboardWarning {
  id: string;
  type: "BOOKING_SPLIT" | "MINOR_WITHOUT_BOOKING_ADULT";
  bookingId: string;
  bookingGuestId?: string;
  stayDate: string;
  roomId?: string;
  message: string;
}

export interface DashboardPayload {
  settings: {
    autoAllocationEnabled: boolean;
    updatedAt: string | null;
    updatedByMemberId: string | null;
  };
  range: { fromDate: string; toDate: string };
  rooms: DashboardRoom[];
  bookings: DashboardBookingSummary[];
  allocations: DashboardAllocation[];
  unallocatedGuestNights: DashboardGuestNight[];
  suggestedAllocations: Array<{
    bookingId: string;
    bookingGuestId: string;
    roomId: string;
    bedId: string;
    stayDate: string;
  }>;
  suggestedUnallocatedGuestNights: Array<{
    bookingId: string;
    bookingGuestId: string;
    stayDate: string;
    reason: string;
  }>;
  warnings: DashboardWarning[];
  // Stay window of a deep-linked focused booking (?bookingId=…) when it is out
  // of the current range; lets the board snap Date In / Date Out onto it (#1302).
  focusedBooking: { id: string; checkIn: string; checkOut: string } | null;
}

export interface BedOption {
  id: string;
  roomId: string;
  roomName: string;
  bedName: string;
  label: string;
}

export interface BedOptionGroup {
  roomId: string;
  roomName: string;
  beds: BedOption[];
}

export interface BucketGuestGroup {
  bookingGuestId: string;
  bookingId: string;
  guestName: string;
  guestAgeTier: string;
  memberName: string;
  stayDates: string[];
}

export const BUCKET_DROPPABLE_ID = "bucket";

export function cellDroppableId(bedId: string, stayDate: string) {
  return `cell:${bedId}:${stayDate}`;
}

export function bucketDraggableId(bookingGuestId: string) {
  return `bucket-guest:${bookingGuestId}`;
}

export function allocationDraggableId(allocationId: string) {
  return `allocation:${allocationId}`;
}

export type DragData =
  | {
      type: "bucket-guest";
      bookingGuestId: string;
    }
  | {
      type: "allocation";
      allocationId: string;
    };

export type DropData =
  | {
      type: "cell";
      bedId: string;
      roomId: string;
      stayDate: string;
    }
  | {
      type: "bucket";
    };

export interface BulkAllocationConflict {
  stayDate: string;
  reason: "BED_TAKEN";
}
