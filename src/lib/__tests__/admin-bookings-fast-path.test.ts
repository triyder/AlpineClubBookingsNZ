import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn() },
    xeroSyncOperation: { findMany: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
  },
}));

import {
  adminBookingsQuerySchema,
  listAdminBookings,
} from "@/lib/admin-bookings-service";
import { prisma } from "@/lib/prisma";

/**
 * The #1146 fast path: with the derived-state filters at their "all" defaults,
 * listAdminBookings must sort a lightweight projection first and load the
 * heavy relations for only the returned page — while producing exactly the
 * ordering the legacy full-scan comparator produces.
 */

function makeGuests(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `guest-${i}`,
    firstName: `Guest${i}`,
    lastName: "Test",
    ageTier: "ADULT",
    isMember: false,
    stayStart: new Date("2026-07-01T00:00:00.000Z"),
    stayEnd: new Date("2026-07-03T00:00:00.000Z"),
  }));
}

function makeBooking(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "PAID",
    checkIn: new Date("2026-07-01T00:00:00.000Z"),
    checkOut: new Date("2026-07-03T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    finalPriceCents: 10_000,
    requiresAdminReview: false,
    adminReviewStatus: null,
    adminReviewReason: null,
    deletedAt: null,
    member: {
      id: `member-${id}`,
      firstName: "Aroha",
      lastName: "Ngata",
      email: `${id}@example.test`,
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

describe("listAdminBookings fast path (#1146)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroObjectLink.findMany).mockResolvedValue([]);
  });

  it("uses a lightweight select pass then loads relations for only the page", async () => {
    const fixtures = [
      makeBooking("b1", { updatedAt: new Date("2026-06-03T00:00:00.000Z") }),
      makeBooking("b2", { updatedAt: new Date("2026-06-01T00:00:00.000Z") }),
      makeBooking("b3", { updatedAt: new Date("2026-06-02T00:00:00.000Z") }),
    ];
    vi.mocked(prisma.booking.findMany).mockResolvedValue(fixtures as never);

    const result = await listAdminBookings(adminBookingsQuerySchema.parse({}));

    // Default sort is lastUpdated desc; ordering must match the legacy comparator.
    expect(result.bookings.map((b) => b.id)).toEqual(["b1", "b3", "b2"]);
    expect(result.total).toBe(3);

    const calls = vi.mocked(prisma.booking.findMany).mock.calls;
    expect(calls).toHaveLength(2);
    // First pass: projection only, no relation includes.
    expect(calls[0][0]).not.toHaveProperty("include");
    expect(calls[0][0]).toHaveProperty("select");
    // Second pass: heavy include restricted to the page ids.
    expect(calls[1][0]).toHaveProperty("include");
    expect(calls[1][0]?.where).toEqual({ id: { in: ["b1", "b3", "b2"] } });
  });

  it("orders every sort key identically on the fast and full comparators", async () => {
    const fixtures = [
      makeBooking("b1", {
        finalPriceCents: 300,
        status: "PAID",
        checkIn: new Date("2026-07-05T00:00:00.000Z"),
        member: { id: "m1", firstName: "Zoe", lastName: "Adams", email: "z@example.test" },
        _count: { guests: 2 },
        guests: makeGuests(2),
      }),
      makeBooking("b2", {
        finalPriceCents: 100,
        status: "CONFIRMED",
        checkIn: new Date("2026-07-01T00:00:00.000Z"),
        member: { id: "m2", firstName: "Amy", lastName: "Baker", email: "a@example.test" },
        _count: { guests: 5 },
        guests: makeGuests(5),
      }),
      makeBooking("b3", {
        finalPriceCents: 200,
        status: "PENDING",
        checkIn: new Date("2026-07-03T00:00:00.000Z"),
        member: { id: "m3", firstName: "Ben", lastName: "Adams", email: "b@example.test" },
        _count: { guests: 1 },
        guests: makeGuests(1),
      }),
    ];
    vi.mocked(prisma.booking.findMany).mockResolvedValue(fixtures as never);

    const expectations: Array<[string, string, string[]]> = [
      // sortBy, sortDir, expected order (legacy comparator semantics)
      ["member", "asc", ["b1", "b3", "b2"]], // "adams zoe" < "adams ben"? No: localeCompare("adams zoe","adams ben") — z > b, so b3 first.
      ["total", "desc", ["b1", "b3", "b2"]],
      ["guests", "asc", ["b3", "b1", "b2"]],
      ["checkIn", "asc", ["b2", "b3", "b1"]],
      // Status sorts by lifecycle rank (#1215), not alphabetically:
      // PENDING(b3) < CONFIRMED(b2) < PAID(b1). Alphabetical would be
      // CONFIRMED(b2), PAID(b1), PENDING(b3).
      ["status", "asc", ["b3", "b2", "b1"]],
    ];

    for (const [sortBy, sortDir, expected] of expectations) {
      vi.mocked(prisma.booking.findMany).mockClear();
      vi.mocked(prisma.booking.findMany).mockResolvedValue(fixtures as never);
      const result = await listAdminBookings(
        adminBookingsQuerySchema.parse({ sortBy, sortDir })
      );
      if (sortBy === "member") {
        // Verified inline: "adams ben" < "adams zoe" per localeCompare.
        expect(result.bookings.map((b) => b.id)).toEqual(["b3", "b1", "b2"]);
      } else {
        expect(result.bookings.map((b) => b.id)).toEqual(expected);
      }
    }
  });

  it("falls back to the full-scan path when a derived-state filter is active", async () => {
    const fixtures = [makeBooking("b1")];
    vi.mocked(prisma.booking.findMany).mockResolvedValue(fixtures as never);

    await listAdminBookings(
      adminBookingsQuerySchema.parse({ paymentSource: "STRIPE" })
    );

    const calls = vi.mocked(prisma.booking.findMany).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toHaveProperty("include");
  });

  it("sorts the status column by lifecycle order, not alphabetically (#1215)", async () => {
    // Distinct lifecycle ranks so the id tie-break never fires:
    // PENDING(1) < CONFIRMED(3) < PAID(4) < CANCELLED(9). Alphabetical asc
    // would instead lead with CANCELLED, so the two orderings diverge cleanly.
    const fixtures = [
      makeBooking("b-confirmed", { status: "CONFIRMED" }),
      makeBooking("b-cancelled", { status: "CANCELLED" }),
      makeBooking("b-pending", { status: "PENDING" }),
      makeBooking("b-paid", { status: "PAID" }),
    ];
    vi.mocked(prisma.booking.findMany).mockResolvedValue(fixtures as never);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ sortBy: "status", sortDir: "asc" })
    );

    const order = result.bookings.map((b) => b.id);
    expect(order).toEqual(["b-pending", "b-confirmed", "b-paid", "b-cancelled"]);
    // Lifecycle-specific relationships called out in the spec.
    expect(order.indexOf("b-confirmed")).toBeLessThan(order.indexOf("b-cancelled"));
    expect(order.indexOf("b-pending")).toBeLessThan(order.indexOf("b-paid"));
    // Guard against a regression to alphabetical ordering, which would lead
    // with CANCELLED.
    expect(order[0]).not.toBe("b-cancelled");
  });

  it("orders the status column identically on the fast and full paths (#1215)", async () => {
    // Zero-guest fixtures keep every row's derived bedState "complete", so the
    // bedState:"complete" filter forces the full-scan path yet drops no rows —
    // letting us compare the sortRowValue (fast) and sortValue (full)
    // comparators on the same set for sortBy:"status".
    const makeFixtures = () => [
      makeBooking("b-confirmed", { status: "CONFIRMED" }),
      makeBooking("b-cancelled", { status: "CANCELLED" }),
      makeBooking("b-pending", { status: "PENDING" }),
      makeBooking("b-paid", { status: "PAID" }),
    ];

    vi.mocked(prisma.booking.findMany).mockResolvedValue(makeFixtures() as never);
    const fastResult = await listAdminBookings(
      adminBookingsQuerySchema.parse({ sortBy: "status", sortDir: "asc" })
    );
    // Fast path: projection pass + page load = two findMany calls.
    expect(vi.mocked(prisma.booking.findMany).mock.calls).toHaveLength(2);

    vi.mocked(prisma.booking.findMany).mockClear();
    vi.mocked(prisma.booking.findMany).mockResolvedValue(makeFixtures() as never);
    const fullResult = await listAdminBookings(
      adminBookingsQuerySchema.parse({ sortBy: "status", sortDir: "asc", bedState: "complete" })
    );
    // Full path: single scan with heavy relation include.
    const fullCalls = vi.mocked(prisma.booking.findMany).mock.calls;
    expect(fullCalls).toHaveLength(1);
    expect(fullCalls[0][0]).toHaveProperty("include");

    const fastOrder = fastResult.bookings.map((b) => b.id);
    const fullOrder = fullResult.bookings.map((b) => b.id);
    expect(fullOrder).toEqual(fastOrder);
    expect(fastOrder).toEqual(["b-pending", "b-confirmed", "b-paid", "b-cancelled"]);
  });
});
