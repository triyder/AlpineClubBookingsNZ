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
import {
  bookingStatusLifecycleRank,
  capacityHoldingBookingFilter,
} from "@/lib/booking-status";
import { bookingsOverlap, sameLodgeNullTolerant } from "@/lib/capacity";
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
import { buildAdditionalOwedWhere } from "@/lib/unpaid-finished-stays";
import { prisma } from "@/lib/prisma";

export type BookingSortBy = "member" | "lastUpdated" | "checkIn" | "guests" | "total" | "status";
export type SortDir = "asc" | "desc";
type BedStateFilter = "all" | "unallocated" | "partial" | "complete" | "warning";
type BedState = Exclude<BedStateFilter, "all">;
type ChangeStateFilter = "all" | "requiresReview" | "pendingRequest" | "hasModification" | "creditGenerated";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// One page of the admin bookings list. Kept as a constant so the service and
// its callers share a single window size (previously a bare `100`).
export const ADMIN_BOOKINGS_PAGE_SIZE = 100;

// Chunk size for the derived-filter candidate scan (#1884): bookings whose
// filters can only be evaluated in JS are loaded in id-ordered chunks of this
// size instead of one unbounded findMany, bounding peak memory while keeping
// exact totals and page contents.
export const ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE = 500;

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
  // Unsettled upward-modification deltas (#1723): "owed" narrows to settled
  // (CONFIRMED/PAID/COMPLETED) bookings whose additional card payment was
  // never collected. The dashboard "Finished Stays With Unpaid Additions"
  // card deep-links here as additionalOwed=owed&checkOutTo=<today>; the SQL
  // fragment is shared with that card's count via unpaid-finished-stays.ts.
  additionalOwed: z.enum(["all", "owed"]).optional().default("all"),
  changeState: z.enum(["all", "requiresReview", "pendingRequest", "hasModification", "creditGenerated"]).optional().default("all"),
  // Page number (1-based). Field-scoped `.catch(1)` so garbage (`page=abc`,
  // `0`, `-3`, `2.5`) coerces to page 1 instead of failing the whole parse and
  // dropping every other filter; an out-of-range page is clamped to the last
  // non-empty page in the service.
  page: z.coerce.number().int().min(1).catch(1),
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
  // This booking overlaps another booking's exclusive whole-lodge hold
  // (ADR-001 decision 1, issue #119). Admin-only signal; flagged so staff see
  // the clash from the ordinary booking's side. A held booking itself is never
  // flagged (it is not overlapping anything — it IS the hold).
  overlapsExclusiveHold: boolean;
};

/**
 * Flag every page row that overlaps another booking's exclusive whole-lodge
 * hold (issue #119). One extra query per page: the capacity-holding held
 * bookings whose nights intersect the page's date span, matched to each row
 * in-memory (same-lodge, half-open overlap). Reuses the capacity engine's
 * overlap + hold-population logic rather than reimplementing it. Admin-only:
 * this list is never rendered to members (decision 6).
 */
async function annotateExclusiveHoldOverlaps(
  rows: AdminBookingRow[]
): Promise<void> {
  if (rows.length === 0) return;
  let minCheckIn = rows[0].checkIn;
  let maxCheckOut = rows[0].checkOut;
  for (const row of rows) {
    if (row.checkIn < minCheckIn) minCheckIn = row.checkIn;
    if (row.checkOut > maxCheckOut) maxCheckOut = row.checkOut;
  }

  const holds = await prisma.booking.findMany({
    where: {
      wholeLodgeHold: true,
      deletedAt: null,
      checkIn: { lt: maxCheckOut },
      checkOut: { gt: minCheckIn },
      // Only a capacity-holding hold blocks admissions; nest under AND so the
      // filter's top-level OR composes with the scalar/date clauses.
      AND: [capacityHoldingBookingFilter()],
    },
    select: { id: true, checkIn: true, checkOut: true, lodgeId: true },
  });

  for (const row of rows) {
    row.overlapsExclusiveHold = holds.some(
      (held) =>
        held.id !== row.id &&
        sameLodgeNullTolerant(held.lodgeId, row.lodgeId) &&
        bookingsOverlap(held, row)
    );
  }
}

export interface AdminBookingsResult {
  bookings: AdminBookingRow[];
  total: number;
  page: number;
  totalPages: number;
  pageSize: number;
  sortBy: BookingSortBy;
  sortDir: SortDir;
}

/**
 * Windows an already-sorted list to one page, for the paths that still sort
 * in JS (member/status sorts and the derived-filter scan — see
 * listAdminBookings; SQL-sortable defaults window via skip/take instead).
 * Clamps the requested page into [1, totalPages] so a narrowed filter never
 * strands the user on an empty page with no way back.
 */
function clampPageWindow<T>(
  items: T[],
  requestedPage: number,
  pageSize = ADMIN_BOOKINGS_PAGE_SIZE
) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (page - 1) * pageSize;
  return { pageItems: items.slice(start, start + pageSize), total, page, totalPages };
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

function sortValue(booking: BookingCandidate, sortBy: BookingSortBy) {
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

  // AND-composed so an explicit status/date choice in the same URL still
  // narrows the result instead of being overwritten by the queue fragment.
  if (query.additionalOwed === "owed") {
    where.AND = [buildAdditionalOwedWhere()];
  }

  if (query.lodgeId) {
    // Null-tolerant: bookings still missing a lodgeId (expand-release
    // tolerance) show under every lodge rather than disappearing.
    Object.assign(where, lodgeNullTolerantScope(query.lodgeId));
  }

  // paymentSource is a real Payment column (#1884), so it filters in SQL
  // rather than in the JS derived-state pass. Payment.source is a
  // non-nullable enum on an optional to-one relation, so "NONE" (the
  // `booking.payment?.source ?? "NONE"` derivation) is exactly "no payment
  // row".
  if (query.paymentSource === "NONE") {
    where.payment = { is: null };
  } else if (query.paymentSource !== "all") {
    where.payment = { is: { source: query.paymentSource } };
  }

  return where;
}

/**
 * SQL-expressible orderings (#1884). Returns null for the two sort modes that
 * genuinely need the JS comparator: "member" sorts on the lowercased
 * "lastName firstName" string and "status" on the lifecycle rank (#1215),
 * neither of which is a plain column ordering. The `id` tie-break mirrors the
 * JS comparators' `localeCompare` fallback; ids are cuids (lowercase
 * alphanumerics), for which database and locale orderings agree.
 */
function buildBookingSqlOrderBy(
  sortBy: BookingSortBy,
  sortDir: SortDir
): Prisma.BookingOrderByWithRelationInput[] | null {
  switch (sortBy) {
    case "checkIn":
      return [{ checkIn: sortDir }, { id: "asc" }];
    case "lastUpdated":
      return [{ updatedAt: sortDir }, { id: "asc" }];
    case "total":
      return [{ finalPriceCents: sortDir }, { id: "asc" }];
    case "guests":
      return [{ guests: { _count: sortDir } }, { id: "asc" }];
    case "member":
    case "status":
      return null;
  }
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

/**
 * Heavy relation load. `scan` (#1884) turns the query into one bounded,
 * id-ordered chunk of a cursor walk so the derived-filter path never holds
 * more than ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE bookings (plus relations)
 * in memory at once.
 */
async function loadBookingCandidates(
  where: Prisma.BookingWhereInput,
  scan?: { take: number; cursorId?: string }
) {
  return prisma.booking.findMany({
    where,
    ...(scan
      ? {
          orderBy: { id: "asc" as const },
          take: scan.take,
          ...(scan.cursorId ? { cursor: { id: scan.cursorId }, skip: 1 } : {}),
        }
      : {}),
    include: {
      lodge: { select: { id: true, name: true } },
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phoneCountryCode: true,
          phoneAreaCode: true,
          phoneNumber: true,
        },
      },
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

  // An exclusive whole-lodge hold (ADR-001, #120) implicitly occupies every
  // bed — it needs NO per-bed allocation, so it must never register as an
  // "unallocated" bed-state gap / stuck state. Report it complete.
  if (booking.wholeLodgeHold) {
    return {
      bedState: "complete",
      expectedGuestNights: 0,
      allocatedGuestNights: 0,
      unapprovedBedAllocations: booking.bedAllocations.filter(
        (allocation) => !allocation.approvedAt
      ).length,
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

/**
 * Loads the heavy relations + Xero activity for one page of booking ids and
 * derives each row's operational state, preserving the given id order. Every
 * list path funnels through this so only ADMIN_BOOKINGS_PAGE_SIZE bookings
 * ever carry the full include tree.
 */
async function hydrateBookingPage(
  pageIds: string[],
  bedAllocationEnabled: boolean
): Promise<AdminBookingRow[]> {
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
        // Defaulted here so the row type is satisfied; set for real by
        // annotateExclusiveHoldOverlaps on the hydrated page (#119).
        overlapsExclusiveHold: false,
      },
    ])
  );

  return pageIds.flatMap((id) => rowsById.get(id) ?? []);
}

export async function listAdminBookings(
  query: AdminBookingsQuery,
  options: AdminBookingsOptions = {}
): Promise<AdminBookingsResult> {
  const sortBy = getAdminBookingSortBy(query);
  const sortDir = query.sortDir ?? getDefaultAdminBookingSortDir(sortBy);
  const bedAllocationEnabled = options.bedAllocationEnabled ?? true;
  const where = buildBookingWhere(query);

  // The Xero/bed/change filters are derived from relations + Xero activity in
  // JS, so they force a candidate scan (bounded since #1884, below). When they
  // are all "all" (the default view, including any paymentSource choice —
  // that one filters in SQL) the JS filter step is a no-op and the page can be
  // resolved without scanning candidates at all.
  const derivedFiltersActive =
    query.xeroState !== "all" ||
    (bedAllocationEnabled && query.bedState !== "all") ||
    query.changeState !== "all";

  if (!derivedFiltersActive) {
    const sqlOrderBy = buildBookingSqlOrderBy(sortBy, sortDir);

    if (sqlOrderBy) {
      // Fully pushed-down path (#1884): count + one SQL-ordered page window,
      // then hydrate just that page. Page clamping mirrors clampPageWindow.
      const total = await prisma.booking.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / ADMIN_BOOKINGS_PAGE_SIZE));
      const page = Math.min(Math.max(1, query.page), totalPages);
      const pageRows = await prisma.booking.findMany({
        where,
        select: { id: true },
        orderBy: sqlOrderBy,
        skip: (page - 1) * ADMIN_BOOKINGS_PAGE_SIZE,
        take: ADMIN_BOOKINGS_PAGE_SIZE,
      });

      const bookings = await hydrateBookingPage(
        pageRows.map((row) => row.id),
        bedAllocationEnabled
      );
      await annotateExclusiveHoldOverlaps(bookings);

      return {
        bookings,
        total,
        page,
        totalPages,
        pageSize: ADMIN_BOOKINGS_PAGE_SIZE,
        sortBy,
        sortDir,
      };
    }

    // Fast path (#1146) for the JS-only comparators ("member" lowercased
    // name, "status" lifecycle rank): sort a lightweight projection, then
    // load the heavy relations for only the page actually returned.
    const direction = sortDir === "asc" ? 1 : -1;
    const sortRows = await loadBookingSortRows(where);
    sortRows.sort((left, right) => {
      const primary =
        compareValues(sortRowValue(left, sortBy), sortRowValue(right, sortBy)) *
        direction;
      if (primary !== 0) return primary;
      return left.id.localeCompare(right.id);
    });

    const { pageItems, total, page, totalPages } = clampPageWindow(
      sortRows,
      query.page
    );
    const bookings = await hydrateBookingPage(
      pageItems.map((row) => row.id),
      bedAllocationEnabled
    );
    await annotateExclusiveHoldOverlaps(bookings);

    return {
      bookings,
      total,
      page,
      totalPages,
      pageSize: ADMIN_BOOKINGS_PAGE_SIZE,
      sortBy,
      sortDir,
    };
  }

  // Derived-filter path (#1884): the candidates are scanned in bounded,
  // id-ordered chunks. Each chunk derives operational state, applies the JS
  // filters and keeps only { id, sort key } for the survivors, so peak memory
  // is one chunk of relation-heavy rows regardless of how many bookings
  // match. Chunk-scoped Xero activity lookups are equivalent to a global load
  // because deriveBookingOperationalState only reads records keyed by the
  // booking's own ids. Totals and page contents stay exact — the whole match
  // set is still visited, never truncated.
  const matches: Array<{ id: string; key: string | number | Date }> = [];
  let cursorId: string | undefined;
  for (;;) {
    const chunk = await loadBookingCandidates(where, {
      take: ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE,
      cursorId,
    });
    if (chunk.length === 0) break;
    const { activityByRecord, invoiceLinkedPaymentIds } =
      await loadXeroStateInputs(chunk);

    for (const booking of chunk) {
      const operational = deriveBookingOperationalState(
        booking,
        activityByRecord,
        invoiceLinkedPaymentIds,
        { bedAllocationEnabled }
      );
      if (!matchesPaymentSourceFilter(operational.paymentSource, query.paymentSource)) {
        continue;
      }
      if (!matchesXeroStateFilter(operational.xeroState, query.xeroState)) {
        continue;
      }
      if (
        bedAllocationEnabled &&
        !matchesBedStateFilter(operational.bedState, query.bedState)
      ) {
        continue;
      }
      if (!matchesChangeStateFilter(operational, query.changeState)) {
        continue;
      }
      matches.push({ id: booking.id, key: sortValue(booking, sortBy) });
    }

    if (chunk.length < ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE) break;
    cursorId = chunk[chunk.length - 1].id;
  }

  const direction = sortDir === "asc" ? 1 : -1;
  matches.sort((left, right) => {
    const primary = compareValues(left.key, right.key) * direction;
    if (primary !== 0) return primary;
    return left.id.localeCompare(right.id);
  });

  const { pageItems, total, page, totalPages } = clampPageWindow(
    matches,
    query.page
  );
  const bookings = await hydrateBookingPage(
    pageItems.map((item) => item.id),
    bedAllocationEnabled
  );
  await annotateExclusiveHoldOverlaps(bookings);

  return {
    bookings,
    total,
    page,
    totalPages,
    pageSize: ADMIN_BOOKINGS_PAGE_SIZE,
    sortBy,
    sortDir,
  };
}
