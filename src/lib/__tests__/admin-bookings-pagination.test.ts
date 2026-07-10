import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn() },
    xeroSyncOperation: { findMany: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
  },
}));

import {
  ADMIN_BOOKINGS_PAGE_SIZE,
  adminBookingsQuerySchema,
  listAdminBookings,
} from "@/lib/admin-bookings-service";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

// Distinct ascending check-in dates (relative to NZ today) so `sortBy:checkIn
// asc` orders the fixtures b0, b1, ... deterministically and we know exactly
// which booking each page window contains.
function makeBooking(index: number, overrides: Record<string, unknown> = {}) {
  const checkIn = addDaysDateOnly(getTodayDateOnly(), index);
  const checkOut = addDaysDateOnly(checkIn, 2);
  return {
    id: `b${index}`,
    status: "PAID",
    checkIn,
    checkOut,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    finalPriceCents: 10_000,
    requiresAdminReview: false,
    adminReviewStatus: null,
    adminReviewReason: null,
    deletedAt: null,
    member: {
      id: `member-${index}`,
      firstName: "Aroha",
      lastName: "Ngata",
      email: `b${index}@example.test`,
    },
    guests: [],
    _count: { guests: 0 },
    payment: null,
    bedAllocations: [],
    modifications: [],
    changeRequests: [],
    creditsFromCancellation: [],
    refundRequests: [],
    ...overrides,
  };
}

const TOTAL = ADMIN_BOOKINGS_PAGE_SIZE + 1; // 101 → exactly two pages

describe("listAdminBookings pagination (#1738)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroObjectLink.findMany).mockResolvedValue([]);
  });

  it("fast path: returns the first page and page metadata by default", async () => {
    const fixtures = Array.from({ length: TOTAL }, (_, i) => makeBooking(i));
    vi.mocked(prisma.booking.findMany).mockResolvedValue(fixtures as never);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ sortBy: "checkIn", sortDir: "asc" })
    );

    expect(result.total).toBe(TOTAL);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(2);
    expect(result.pageSize).toBe(ADMIN_BOOKINGS_PAGE_SIZE);
    expect(result.bookings).toHaveLength(ADMIN_BOOKINGS_PAGE_SIZE);
    expect(result.bookings[0].id).toBe("b0");
    expect(result.bookings.at(-1)?.id).toBe(`b${ADMIN_BOOKINGS_PAGE_SIZE - 1}`);
  });

  it("fast path: windows to the requested page", async () => {
    const fixtures = Array.from({ length: TOTAL }, (_, i) => makeBooking(i));
    vi.mocked(prisma.booking.findMany).mockResolvedValue(fixtures as never);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ sortBy: "checkIn", sortDir: "asc", page: "2" })
    );

    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.total).toBe(TOTAL);
    // Only the 101st booking spills onto page 2.
    expect(result.bookings.map((b) => b.id)).toEqual([`b${ADMIN_BOOKINGS_PAGE_SIZE}`]);

    // The heavy relation load is restricted to just the page's id.
    const calls = vi.mocked(prisma.booking.findMany).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0]?.where).toEqual({ id: { in: [`b${ADMIN_BOOKINGS_PAGE_SIZE}`] } });
  });

  it("fast path: clamps an out-of-range page to the last non-empty page", async () => {
    const fixtures = Array.from({ length: TOTAL }, (_, i) => makeBooking(i));
    vi.mocked(prisma.booking.findMany).mockResolvedValue(fixtures as never);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ sortBy: "checkIn", sortDir: "asc", page: "99" })
    );

    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.bookings.map((b) => b.id)).toEqual([`b${ADMIN_BOOKINGS_PAGE_SIZE}`]);
  });

  it("filtered path: windows the derived-filter result set to the requested page", async () => {
    // paymentSource:NONE forces the full-scan path; every fixture has no
    // payment, so all 101 survive the filter and get windowed in JS.
    const fixtures = Array.from({ length: TOTAL }, (_, i) => makeBooking(i));
    vi.mocked(prisma.booking.findMany).mockResolvedValue(fixtures as never);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({
        sortBy: "checkIn",
        sortDir: "asc",
        paymentSource: "NONE",
        page: "2",
      })
    );

    // Single scan (no fast-path projection pass).
    expect(vi.mocked(prisma.booking.findMany).mock.calls).toHaveLength(1);
    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.total).toBe(TOTAL);
    expect(result.bookings.map((b) => b.id)).toEqual([`b${ADMIN_BOOKINGS_PAGE_SIZE}`]);
  });

  it("coerces garbage page values to page 1 without dropping other filters", async () => {
    const parsed = adminBookingsQuerySchema.parse({ status: "PAID", page: "abc" });
    expect(parsed.page).toBe(1);
    expect(parsed.status).toBe("PAID");

    expect(adminBookingsQuerySchema.parse({ page: "0" }).page).toBe(1);
    expect(adminBookingsQuerySchema.parse({ page: "-4" }).page).toBe(1);
    expect(adminBookingsQuerySchema.parse({ page: "2.5" }).page).toBe(1);
    expect(adminBookingsQuerySchema.parse({}).page).toBe(1);
    expect(adminBookingsQuerySchema.parse({ page: "3" }).page).toBe(3);
  });
});
