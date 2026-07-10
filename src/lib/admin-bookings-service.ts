import { BookingStatus, type Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildXeroActivityByRecord,
  deriveXeroState,
  emptyXeroActivitySummary,
  mergeXeroActivitySummaries,
  matchesXeroStateFilter,
  paymentSourceFilters,
  xeroStateFilters,
  type PaymentSourceFilter,
  type XeroActivitySummary,
  type XeroState,
} from "@/lib/admin-operational-state";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";
import { bookingStatusLifecycleRank } from "@/lib/booking-status";
import {
  buildBookingDeletedWhere,
  parseBookingDeletedVisibility,
} from "@/lib/booking-delete-visibility";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  endOfDateOnlyForTimeZone,
  formatDateOnly,
  getTodayDateOnly,
  parseDateOnly,
  startOfDateOnlyForTimeZone,
} from "@/lib/date-only";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

export type BookingSortBy = "member" | "lastUpdated" | "checkIn" | "guests" | "total" | "status";
export type SortDir = "asc" | "desc";
type BedStateFilter = "all" | "unallocated" | "partial" | "complete" | "warning";
type BedState = Exclude<BedStateFilter, "all">;
type ChangeStateFilter = "all" | "requiresReview" | "pendingRequest" | "hasModification" | "creditGenerated";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const bookingSortColumns = new Set<BookingSortBy>([
  "member",
  "lastUpdated",
  "checkIn",
  "guests",
  "total",
  "status",
]);

const validBookingStatuses = new Set<BookingStatus>(Object.values(BookingStatus));

export const adminBookingsQuerySchema = z.object({
  status: z.string().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  updatedFrom: dateSchema.optional(),
  updatedTo: dateSchema.optional(),
  checkInFrom: dateSchema.optional(),
  checkInTo: dateSchema.optional(),
  // Check-out range (#1709): lets the dashboard "Unpaid Finished Stays" card
  // deep-link to status=PAYMENT_PENDING&checkOutTo=<today> — every finished
  // stay with payment still owing (retroactive card creates qualify from the
  // moment of creation).
  checkOutFrom: dateSchema.optional(),
  checkOutTo: dateSchema.optional(),
  search: z.string().trim().max(100).optional(),
  upcoming: z.string().optional(),
  sort: z.string().optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  month: z.string().optional(),
  deleted: z.string().optional(),
  // Lodge filter (multi-lodge phase 8); the UI only offers it once a second
  // active lodge exists.
  lodgeId: z.string().min(1).optional(),
  paymentSource: z.enum(paymentSourceFilters).optional().default("all"),
  xeroState: z.enum(xeroStateFilters).optional().default("all"),
  bedState: z.enum(["all", "unallocated", "partial", "complete", "warning"]).optional().default("all"),
  changeState: z.enum(["all", "requiresReview", "pendingRequest", "hasModification", "creditGenerated"]).optional().default("all"),
});

export type AdminBookingsQuery = z.infer<typeof adminBookingsQuerySchema>;

type BookingCandidate = Awaited<ReturnType<typeof loadBookingCandidates>>[number];

interface AdminBookingOperationalState {
  paymentSource: PaymentSourceFilter;
  xeroState: XeroState;
  xeroActivity: XeroActivitySummary;
  invoiceLinked: boolean;
  invoiceExpected: boolean;
  bedState: BedState;
  expectedGuestNights: number;
  allocatedGuestNights: number;
  unapprovedBedAllocations: number;
  bedWarningCount: number;
  hasPerGuestDates: boolean;
  guestDateRanges: Array<{
    guestId: string;
    guestName: string;
    stayStart: string;
    stayEnd: string;
  }>;
  requiresReview: boolean;
  pendingChangeRequest: boolean;
  hasModification: boolean;
  creditGenerated: boolean;
  refundGenerated: boolean;
}

export type AdminBookingRow = BookingCandidate & {
  operational: AdminBookingOperationalState;
};

export interface AdminBookingsResult {
  bookings: AdminBookingRow[];
  total: number;
  sortBy: BookingSortBy;
  sortDir: SortDir;
}

export interface AdminBookingsOptions {
  bedAllocationEnabled?: boolean;
}

function parseDateOnlyFilter(value: string) {
  return parseDateOnly(value);
}

function parseDateTimeStart(value: string) {
  return startOfDateOnlyForTimeZone(value);
}

function parseDateTimeEnd(value: string) {
  return endOfDateOnlyForTimeZone(value);
}

function monthEndDateOnly(year: number, month: number) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function getAdminBookingSortBy(params: { sortBy?: string; sort?: string }): BookingSortBy {
  const requested = params.sortBy ?? params.sort;
  return bookingSortColumns.has(requested as BookingSortBy)
    ? (requested as BookingSortBy)
    : "lastUpdated";
}

export function getDefaultAdminBookingSortDir(sortBy: BookingSortBy): SortDir {
  return sortBy === "member" || sortBy === "status" ? "asc" : "desc";
}

function memberSortValue(booking: BookingCandidate) {
  return `${booking.member.lastName} ${booking.member.firstName}`.toLowerCase();
}

function compareValues(left: string | number | Date | null, right: string | number | Date | null) {
  const normalizedLeft = left instanceof Date ? left.getTime() : left ?? "";
  const normalizedRight = right instanceof Date ? right.getTime() : right ?? "";

  if (typeof normalizedLeft === "number" && typeof normalizedRight === "number") {
    return normalizedLeft - normalizedRight;
  }

  return String(normalizedLeft).localeCompare(String(normalizedRight));
}

function sortValue(booking: AdminBookingRow, sortBy: BookingSortBy) {
  switch (sortBy) {
    case "member":
      return memberSortValue(booking);
    case "checkIn":
      return booking.checkIn;
    case "guests":
      return booking.guests.length;
    case "total":
      return booking.finalPriceCents;
    case "status":
      return bookingStatusLifecycleRank(booking.status);
    case "lastUpdated":
    default:
      return booking.updatedAt;
  }
}

function bookingStatusWhere(statusFilter: string | undefined): Prisma.BookingWhereInput["status"] {
  if (statusFilter === "DRAFT") {
    return BookingStatus.DRAFT;
  }

  if (statusFilter && statusFilter !== "all") {
    const statuses = statusFilter
      .split(",")
      .map((status) => status.trim())
      .filter((status): status is BookingStatus =>
        validBookingStatuses.has(status as BookingStatus)
      );
    return statuses.length === 1 ? statuses[0] : { in: statuses };
  }

  return { not: BookingStatus.DRAFT };
}

function buildBookingWhere(query: AdminBookingsQuery): Prisma.BookingWhereInput {
  const where: Prisma.BookingWhereInput = {
    status: bookingStatusWhere(query.status),
  };
  const checkInFilter: Prisma.DateTimeFilter = {};
  const checkOutFilter: Prisma.DateTimeFilter = {};
  const updatedAtFilter: Prisma.DateTimeFilter = {};
  const checkInFrom = query.checkInFrom ?? query.from;
  const checkInTo = query.checkInTo;
  // Legacy `to` historically bounded check-out; the explicit named params
  // (checkInTo / checkOutTo) take precedence over it.
  const legacyToDate = query.checkInTo || query.checkOutTo ? undefined : query.to;
  const upcomingDays = query.upcoming ? parseInt(query.upcoming, 10) : null;

  Object.assign(where, buildBookingDeletedWhere(parseBookingDeletedVisibility(query.deleted)));

  if (upcomingDays !== null && !isNaN(upcomingDays)) {
    const today = getTodayDateOnly();
    const futureDate = addDaysDateOnly(today, upcomingDays);
    checkInFilter.gte = today;
    checkInFilter.lte = futureDate;

    if (!query.status) {
      where.status = {
        in: [
          BookingStatus.PAYMENT_PENDING,
          BookingStatus.CONFIRMED,
          BookingStatus.PAID,
          BookingStatus.PENDING,
        ],
      };
    }
  }

  if (query.month && /^\d{4}-\d{2}$/.test(query.month)) {
    const [year, month] = query.month.split("-").map(Number);
    checkInFilter.gte = parseDateOnly(`${year}-${String(month).padStart(2, "0")}-01`);
    checkInFilter.lte = parseDateOnly(monthEndDateOnly(year, month));
  }

  if (checkInFrom) checkInFilter.gte = parseDateOnlyFilter(checkInFrom);
  if (checkInTo) checkInFilter.lte = parseDateOnlyFilter(checkInTo);
  if (legacyToDate) checkOutFilter.lte = parseDateOnlyFilter(legacyToDate);
  if (query.checkOutFrom) checkOutFilter.gte = parseDateOnlyFilter(query.checkOutFrom);
  if (query.checkOutTo) checkOutFilter.lte = parseDateOnlyFilter(query.checkOutTo);
  if (query.updatedFrom) updatedAtFilter.gte = parseDateTimeStart(query.updatedFrom);
  if (query.updatedTo) updatedAtFilter.lte = parseDateTimeEnd(query.updatedTo);

  if (query.search?.trim()) {
    const queryTerms = query.search.trim().split(/\s+/).filter(Boolean);
    where.member = {
      is: {
        AND: queryTerms.map((term) => ({
          OR: [
            { firstName: { contains: term, mode: "insensitive" } },
            { lastName: { contains: term, mode: "insensitive" } },
            { email: { contains: term, mode: "insensitive" } },
          ],
        })),
      },
    };
  }

  if (Object.keys(checkInFilter).length > 0) where.checkIn = checkInFilter;
  if (Object.keys(checkOutFilter).length > 0) where.checkOut = checkOutFilter;
  if (Object.keys(updatedAtFilter).length > 0) where.updatedAt = updatedAtFilter;

  if (query.lodgeId) {
    // Null-tolerant: bookings still missing a lodgeId (expand-release
    // tolerance) show under every lodge rather than disappearing.
    Object.assign(where, lodgeNullTolerantScope(query.lodgeId));
  }

  return where;
}

/**
 * Lightweight first pass for the default list view (#1146): only the columns
 * the sort comparator needs. The heavy relation load then happens for just
 * the page of bookings actually returned, instead of every match.
 */
async function loadBookingSortRows(where: Prisma.BookingWhereInput) {
  return prisma.booking.findMany({
    where,
    select: {
      id: true,
      checkIn: true,
      updatedAt: true,
      finalPriceCents: true,
      status: true,
      member: { select: { firstName: true, lastName: true } },
      _count: { select: { guests: true } },
    },
  });
}

type BookingSortRow = Awaited<ReturnType<typeof loadBookingSortRows>>[number];

/**
 * Sort key for the lightweight rows. MUST stay semantically identical to
 * sortValue() below — the fast path is only valid because the two comparators
 * order the same bookings the same way.
 */
function sortRowValue(row: BookingSortRow, sortBy: BookingSortBy) {
  switch (sortBy) {
    case "member":
      return `${row.member.lastName} ${row.member.firstName}`.toLowerCase();
    case "checkIn":
      return row.checkIn;
    case "guests":
      return row._count?.guests ?? 0;
    case "total":
      return row.finalPriceCents;
    case "status":
      return bookingStatusLifecycleRank(row.status);
    case "lastUpdated":
    default:
      return row.updatedAt;
  }
}

async function loadBookingCandidates(where: Prisma.BookingWhereInput) {
  return prisma.booking.findMany({
    where,
    include: {
      lodge: { select: { id: true, name: true } },
      member: { select: { id: true, firstName: true, lastName: true, email: true } },
      guests: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          ageTier: true,
          isMember: true,
          stayStart: true,
          stayEnd: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      payment: {
        select: {
          id: true,
          source: true,
          status: true,
          xeroInvoiceId: true,
          xeroInvoiceNumber: true,
          refundedAmountCents: true,
        },
      },
      bedAllocations: {
        include: {
          bookingGuest: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              ageTier: true,
            },
          },
          room: { select: { id: true, name: true } },
          bed: { select: { id: true, name: true } },
        },
      },
      modifications: {
        select: {
          id: true,
          modificationType: true,
          priceDiffCents: true,
          createdAt: true,
          creditsFromModification: {
            select: {
              id: true,
              amountCents: true,
              xeroCreditNoteId: true,
            },
          },
        },
      },
      changeRequests: {
        select: {
          id: true,
          status: true,
          createdAt: true,
          linkedModificationId: true,
        },
      },
      creditsFromCancellation: {
        select: {
          id: true,
          amountCents: true,
          description: true,
          xeroCreditNoteId: true,
        },
      },
      refundRequests: {
        select: {
          id: true,
          status: true,
          approvedAmountCents: true,
        },
      },
    },
  });
}

function guestName(guest: { firstName: string; lastName: string }) {
  return [guest.firstName, guest.lastName].filter(Boolean).join(" ");
}

function guestNightKeys(guest: { id: string; stayStart: Date; stayEnd: Date }) {
  return eachDateOnlyInRange(guest.stayStart, guest.stayEnd).map(
    (date) => `${guest.id}:${formatDateOnly(date)}`
  );
}

function buildBedWarnings(
  allocations: BookingCandidate["bedAllocations"]
) {
  const warnings: Array<{ bookingGuestId?: string; stayDate: string }> = [];
  const allocationsByNight = new Map<string, typeof allocations>();

  for (const allocation of allocations) {
    const key = `${allocation.bookingId}:${formatDateOnly(allocation.stayDate)}`;
    const current = allocationsByNight.get(key) ?? [];
    current.push(allocation);
    allocationsByNight.set(key, current);
  }

  for (const group of allocationsByNight.values()) {
    const roomIds = new Set(group.map((allocation) => allocation.roomId));
    if (roomIds.size > 1) {
      warnings.push({ stayDate: formatDateOnly(group[0].stayDate) });
    }

    for (const allocation of group) {
      if (allocation.bookingGuest.ageTier === "ADULT") continue;

      const hasBookingAdultInRoom = group.some(
        (candidate) =>
          candidate.roomId === allocation.roomId &&
          candidate.bookingGuest.ageTier === "ADULT"
      );
      if (!hasBookingAdultInRoom) {
        warnings.push({
          bookingGuestId: allocation.bookingGuestId,
          stayDate: formatDateOnly(allocation.stayDate),
        });
      }
    }
  }

  return warnings;
}

function deriveBedState(
  booking: BookingCandidate,
  bedAllocationEnabled = true
): Pick<
  AdminBookingOperationalState,
  | "bedState"
  | "expectedGuestNights"
  | "allocatedGuestNights"
  | "unapprovedBedAllocations"
  | "bedWarningCount"
> {
  if (!bedAllocationEnabled) {
    return {
      bedState: "complete",
      expectedGuestNights: 0,
      allocatedGuestNights: 0,
      unapprovedBedAllocations: 0,
      bedWarningCount: 0,
    };
  }

  const expectedGuestNightKeys = new Set(
    booking.guests.flatMap((guest) => guestNightKeys(guest))
  );
  const allocationKeys = new Set(
    booking.bedAllocations.map(
      (allocation) =>
        `${allocation.bookingGuestId}:${formatDateOnly(allocation.stayDate)}`
    )
  );
  const allocatedGuestNights = [...expectedGuestNightKeys].filter((key) =>
    allocationKeys.has(key)
  ).length;
  const bedWarnings = buildBedWarnings(booking.bedAllocations);
  const allocatable = (BED_ALLOCATABLE_BOOKING_STATUSES as readonly string[]).includes(
    booking.status
  );
  let bedState: BedState = "complete";

  if (bedWarnings.length > 0) {
    bedState = "warning";
  } else if (expectedGuestNightKeys.size > 0 && allocatable) {
    if (allocatedGuestNights === 0) bedState = "unallocated";
    else if (allocatedGuestNights < expectedGuestNightKeys.size) bedState = "partial";
    else bedState = "complete";
  }

  return {
    bedState,
    expectedGuestNights: expectedGuestNightKeys.size,
    allocatedGuestNights,
    unapprovedBedAllocations: booking.bedAllocations.filter(
      (allocation) => !allocation.approvedAt
    ).length,
    bedWarningCount: bedWarnings.length,
  };
}

function matchesPaymentSourceFilter(
  paymentSource: PaymentSourceFilter,
  filter: PaymentSourceFilter
) {
  return filter === "all" || paymentSource === filter;
}

function matchesBedStateFilter(bedState: BedState, filter: BedStateFilter) {
  return filter === "all" || bedState === filter;
}

function matchesChangeStateFilter(
  state: AdminBookingOperationalState,
  filter: ChangeStateFilter
) {
  switch (filter) {
    case "requiresReview":
      return state.requiresReview;
    case "pendingRequest":
      return state.pendingChangeRequest;
    case "hasModification":
      return state.hasModification;
    case "creditGenerated":
      return state.creditGenerated;
    case "all":
    default:
      return true;
  }
}

function deriveBookingOperationalState(
  booking: BookingCandidate,
  activityByRecord: Map<string, XeroActivitySummary>,
  invoiceLinkedPaymentIds: Set<string>,
  options: AdminBookingsOptions = {}
): AdminBookingOperationalState {
  const paymentSource = (booking.payment?.source ?? "NONE") as PaymentSourceFilter;
  const activity = mergeXeroActivitySummaries([
    activityByRecord.get(`Booking:${booking.id}`) ?? emptyXeroActivitySummary(),
    booking.payment
      ? activityByRecord.get(`Payment:${booking.payment.id}`) ?? emptyXeroActivitySummary()
      : emptyXeroActivitySummary(),
    ...booking.modifications.map(
      (modification) =>
        activityByRecord.get(`BookingModification:${modification.id}`) ??
        emptyXeroActivitySummary()
    ),
  ]);
  const invoiceExpected = booking.payment
    ? ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(booking.payment.status)
    : false;
  const invoiceLinked =
    Boolean(booking.payment?.xeroInvoiceId) ||
    (booking.payment ? invoiceLinkedPaymentIds.has(booking.payment.id) : false);
  const hasPerGuestDates = booking.guests.some(
    (guest) =>
      formatDateOnly(guest.stayStart) !== formatDateOnly(booking.checkIn) ||
      formatDateOnly(guest.stayEnd) !== formatDateOnly(booking.checkOut)
  );
  const guestDateRanges = hasPerGuestDates
    ? booking.guests.map((guest) => ({
        guestId: guest.id,
        guestName: guestName(guest),
        stayStart: formatDateOnly(guest.stayStart),
        stayEnd: formatDateOnly(guest.stayEnd),
      }))
    : [];
  const creditGenerated =
    booking.creditsFromCancellation.length > 0 ||
    booking.modifications.some((modification) => modification.creditsFromModification.length > 0);

  return {
    paymentSource,
    xeroState: deriveXeroState({ invoiceExpected, invoiceLinked, activity }),
    xeroActivity: activity,
    invoiceLinked,
    invoiceExpected,
    ...deriveBedState(booking, options.bedAllocationEnabled ?? true),
    hasPerGuestDates,
    guestDateRanges,
    requiresReview:
      booking.requiresAdminReview || booking.adminReviewStatus === "PENDING",
    pendingChangeRequest: booking.changeRequests.some(
      (request) => request.status === "REQUESTED"
    ),
    hasModification: booking.modifications.length > 0,
    creditGenerated,
    refundGenerated:
      (booking.payment?.refundedAmountCents ?? 0) > 0 ||
      booking.refundRequests.some((request) => request.status === "APPROVED"),
  };
}

async function loadXeroStateInputs(bookings: BookingCandidate[]) {
  const bookingIds = bookings.map((booking) => booking.id);
  const paymentIds = bookings
    .map((booking) => booking.payment?.id)
    .filter((id): id is string => Boolean(id));
  const modificationIds = bookings.flatMap((booking) =>
    booking.modifications.map((modification) => modification.id)
  );
  const operationScope: Prisma.XeroSyncOperationWhereInput[] = [
    ...(bookingIds.length ? [{ localModel: "Booking", localId: { in: bookingIds } }] : []),
    ...(paymentIds.length ? [{ localModel: "Payment", localId: { in: paymentIds } }] : []),
    ...(modificationIds.length
      ? [{ localModel: "BookingModification", localId: { in: modificationIds } }]
      : []),
  ];

  const [activityOperations, primaryInvoiceLinks] = await Promise.all([
    operationScope.length
      ? prisma.xeroSyncOperation.findMany({
          where: { OR: operationScope },
          select: {
            id: true,
            status: true,
            localModel: true,
            localId: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
    paymentIds.length
      ? prisma.xeroObjectLink.findMany({
          where: {
            localModel: "Payment",
            localId: { in: paymentIds },
            xeroObjectType: "INVOICE",
            role: "PRIMARY_INVOICE",
            active: true,
          },
          select: { localId: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    activityByRecord: buildXeroActivityByRecord(activityOperations),
    invoiceLinkedPaymentIds: new Set(primaryInvoiceLinks.map((link) => link.localId)),
  };
}

export async function listAdminBookings(
  query: AdminBookingsQuery,
  options: AdminBookingsOptions = {}
): Promise<AdminBookingsResult> {
  const sortBy = getAdminBookingSortBy(query);
  const sortDir = query.sortDir ?? getDefaultAdminBookingSortDir(sortBy);
  const bedAllocationEnabled = options.bedAllocationEnabled ?? true;
  const where = buildBookingWhere(query);

  // Fast path (#1146): the payment-source/Xero/bed/change filters are derived
  // from relations + Xero activity in JS, so they force loading every match.
  // When they are all "all" (the default view) the filter step is a no-op, so
  // sort on a lightweight projection first and load the heavy relations for
  // only the page actually returned.
  const derivedFiltersActive =
    query.paymentSource !== "all" ||
    query.xeroState !== "all" ||
    (bedAllocationEnabled && query.bedState !== "all") ||
    query.changeState !== "all";

  if (!derivedFiltersActive) {
    const direction = sortDir === "asc" ? 1 : -1;
    const sortRows = await loadBookingSortRows(where);
    sortRows.sort((left, right) => {
      const primary =
        compareValues(sortRowValue(left, sortBy), sortRowValue(right, sortBy)) *
        direction;
      if (primary !== 0) return primary;
      return left.id.localeCompare(right.id);
    });

    const pageIds = sortRows.slice(0, 100).map((row) => row.id);
    const pageCandidates = await loadBookingCandidates({ id: { in: pageIds } });
    const { activityByRecord, invoiceLinkedPaymentIds } =
      await loadXeroStateInputs(pageCandidates);
    const rowsById = new Map(
      pageCandidates.map((booking): [string, AdminBookingRow] => [
        booking.id,
        {
          ...booking,
          operational: deriveBookingOperationalState(
            booking,
            activityByRecord,
            invoiceLinkedPaymentIds,
            { bedAllocationEnabled }
          ),
        },
      ])
    );

    return {
      bookings: pageIds.flatMap((id) => rowsById.get(id) ?? []),
      total: sortRows.length,
      sortBy,
      sortDir,
    };
  }

  const candidates = await loadBookingCandidates(where);
  const { activityByRecord, invoiceLinkedPaymentIds } = await loadXeroStateInputs(candidates);

  const filtered = candidates
    .map((booking): AdminBookingRow => ({
      ...booking,
      operational: deriveBookingOperationalState(
        booking,
        activityByRecord,
        invoiceLinkedPaymentIds,
        { bedAllocationEnabled }
      ),
    }))
    .filter((booking) => {
      if (!matchesPaymentSourceFilter(booking.operational.paymentSource, query.paymentSource)) {
        return false;
      }
      if (!matchesXeroStateFilter(booking.operational.xeroState, query.xeroState)) {
        return false;
      }
      if (
        bedAllocationEnabled &&
        !matchesBedStateFilter(booking.operational.bedState, query.bedState)
      ) {
        return false;
      }
      if (!matchesChangeStateFilter(booking.operational, query.changeState)) {
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      const direction = sortDir === "asc" ? 1 : -1;
      const primary = compareValues(sortValue(left, sortBy), sortValue(right, sortBy)) * direction;
      if (primary !== 0) return primary;
      return left.id.localeCompare(right.id);
    });

  return {
    bookings: filtered.slice(0, 100),
    total: filtered.length,
    sortBy,
    sortDir,
  };
}
