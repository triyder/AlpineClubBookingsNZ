import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma
const mockFindMany = vi.fn();
const mockUpdate = vi.fn();
const mockFindUnique = vi.fn();
const mockTransaction = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    booking: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

// Mock email
vi.mock("../email", () => ({
  sendBookingBumpedEmail: vi.fn(),
  sendBookingConfirmedEmail: vi.fn(),
  sendBookingPendingEmail: vi.fn(),
  sendBookingGuestsRemovedEmail: vi.fn(),
  sendAdminBookingBumpedAlert: vi.fn().mockResolvedValue(undefined),
}));

import {
  getOccupiedBedsPerNight,
  wouldExceedCapacity,
  bumpPendingBookings,
  sendBumpedNotifications,
  sendPartialBumpNotifications,
} from "../bumping";
import { FALLBACK_LODGE_CAPACITY as LODGE_CAPACITY } from "../lodge-capacity";
import {
  sendBookingBumpedEmail,
  sendBookingGuestsRemovedEmail,
} from "../email";

// Helper to create a fake booking with guests
function makeBooking(
  id: string,
  checkIn: string,
  checkOut: string,
  guestCount: number,
  status: string = "PAID",
  createdAt: string = "2026-01-01T00:00:00Z"
) {
  return {
    id,
    checkIn: new Date(checkIn),
    checkOut: new Date(checkOut),
    status,
    createdAt: new Date(createdAt),
    memberId: `member_${id}`,
    member: {
      id: `member_${id}`,
      email: `${id}@example.com`,
      firstName: "Test",
      lastName: "User",
    },
    guests: Array.from({ length: guestCount }, (_, i) => ({
      id: `guest_${id}_${i}`,
      bookingId: id,
      firstName: `Guest${i}`,
      lastName: "Test",
      ageTier: "ADULT",
      isMember: false,
      priceCents: 5000,
    })),
  };
}

describe("Bumping Algorithm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("wouldExceedCapacity", () => {
    it("returns false when adding guests stays within capacity", () => {
      const occupied = new Map([["2026-07-10", LODGE_CAPACITY - 5]]);
      expect(wouldExceedCapacity(occupied, 5)).toBe(false);
    });

    it("returns false when exactly at capacity", () => {
      const occupied = new Map([["2026-07-10", LODGE_CAPACITY - 4]]);
      expect(wouldExceedCapacity(occupied, 4)).toBe(false);
    });

    it("returns true when adding guests exceeds capacity", () => {
      const occupied = new Map([["2026-07-10", LODGE_CAPACITY - 3]]);
      expect(wouldExceedCapacity(occupied, 4)).toBe(true);
    });

    it("checks all nights - returns true if any night exceeds", () => {
      const occupied = new Map([
        ["2026-07-10", LODGE_CAPACITY - 9],
        ["2026-07-11", LODGE_CAPACITY - 1],
        ["2026-07-12", LODGE_CAPACITY - 14],
      ]);
      expect(wouldExceedCapacity(occupied, 2)).toBe(true);
    });

    it("returns false when all nights have room", () => {
      const occupied = new Map([
        ["2026-07-10", LODGE_CAPACITY - 9],
        ["2026-07-11", LODGE_CAPACITY - 4],
        ["2026-07-12", LODGE_CAPACITY - 14],
      ]);
      expect(wouldExceedCapacity(occupied, 4)).toBe(false);
    });
  });

  describe("getOccupiedBedsPerNight", () => {
    it("only counts bookings whose status holds capacity (no PENDING)", async () => {
      // The real query filters to CAPACITY_HOLDING_BOOKING_STATUSES, which since
      // #737/#738 excludes PENDING. The mock therefore returns only committed
      // bookings, and the query must never ask for PENDING occupancy.
      const bookings = [
        makeBooking("b1", "2026-07-10", "2026-07-12", 3, "CONFIRMED"),
        makeBooking("b2", "2026-07-11", "2026-07-13", 2, "PAID"),
      ];

      const txMock = {
        booking: {
          findMany: vi.fn().mockResolvedValue(bookings),
        },
      };

      const result = await getOccupiedBedsPerNight(
        new Date("2026-07-10"),
        new Date("2026-07-13"),
        [],
        txMock as never
      );

      // July 10: only b1 (3 guests)
      expect(result.get("2026-07-10")).toBe(3);
      // July 11: b1 (3) + b2 (2) = 5
      expect(result.get("2026-07-11")).toBe(5);
      // July 12: only b2 (2 guests)
      expect(result.get("2026-07-12")).toBe(2);

      const where = txMock.booking.findMany.mock.calls[0][0].where;
      expect(where.status.in).not.toContain("PENDING");
    });

    it("excludes specified booking IDs", async () => {
      const txMock = {
        booking: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      await getOccupiedBedsPerNight(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        ["excluded_id"],
        txMock as never
      );

      expect(txMock.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { notIn: ["excluded_id"] },
          }),
        })
      );
    });

    it("returns empty occupancy for date range with no bookings", async () => {
      const txMock = {
        booking: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      const result = await getOccupiedBedsPerNight(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        [],
        txMock as never
      );

      expect(result.get("2026-07-10")).toBe(0);
      expect(result.get("2026-07-11")).toBe(0);
    });
  });

  // Since #737/#738 a PENDING booking holds no capacity, so the old
  // most-recent-first bump has been retired: bumpPendingBookings now only
  // reports whether the incoming guests fit against committed bookings and can
  // never manufacture capacity by bumping a PENDING booking. The occupancy mock
  // here reflects the real status filter (no PENDING in the occupancy result).
  describe("bumpPendingBookings", () => {
    it("returns capacityRestored=true when the incoming guests fit against committed bookings", async () => {
      const committed = makeBooking(
        "paid1", "2026-07-10", "2026-07-12", LODGE_CAPACITY - 4, "PAID"
      );
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      const txMock = {
        booking: {
          findMany: vi.fn().mockResolvedValue([committed]),
          update: vi.fn(),
          updateMany,
        },
      };

      const result = await bumpPendingBookings(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        4,
        txMock as never
      );

      expect(result.capacityRestored).toBe(true);
      expect(result.bumpedBookingIds).toHaveLength(0);
      expect(result.partiallyBumpedBookingIds).toHaveLength(0);
      // Never marks a PENDING booking BUMPED.
      expect(updateMany).not.toHaveBeenCalled();
      // Only the occupancy query runs — no second query for bump candidates.
      expect(txMock.booking.findMany).toHaveBeenCalledTimes(1);
    });

    it("returns capacityRestored=false and bumps nothing when committed bookings fill the lodge", async () => {
      // The lodge is full of committed (PAID) bookings. An overlapping PENDING
      // booking exists, but it holds no capacity and so is not in the occupancy
      // result. The probe must not bump it to fake room (issue #738 regression).
      const committed = makeBooking(
        "paid1", "2026-07-10", "2026-07-12", LODGE_CAPACITY, "PAID"
      );
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      const txMock = {
        booking: {
          findMany: vi.fn().mockResolvedValue([committed]),
          update: vi.fn(),
          updateMany,
        },
      };

      const result = await bumpPendingBookings(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        2,
        txMock as never
      );

      expect(result.capacityRestored).toBe(false);
      expect(result.bumpedBookingIds).toHaveLength(0);
      expect(result.partiallyBumpedBookingIds).toHaveLength(0);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it("does not count staggered proposed guests on nights they are not active", async () => {
      const fullFirstNight = makeBooking(
        "conf1", "2026-07-10", "2026-07-11", LODGE_CAPACITY, "CONFIRMED"
      );
      const oneBedLeftSecondNight = makeBooking(
        "conf2", "2026-07-11", "2026-07-12", LODGE_CAPACITY - 1, "CONFIRMED"
      );
      const txMock = {
        booking: {
          findMany: vi.fn().mockResolvedValue([
            fullFirstNight,
            oneBedLeftSecondNight,
          ]),
          update: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };

      const result = await bumpPendingBookings(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        [
          {
            stayStart: new Date("2026-07-11"),
            stayEnd: new Date("2026-07-12"),
          },
        ],
        txMock as never
      );

      // The proposed guest only stays the second night, where there is room.
      expect(result.capacityRestored).toBe(true);
      expect(txMock.booking.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("sendBumpedNotifications", () => {
    it("sends emails for each bumped booking", async () => {
      const booking = makeBooking("b1", "2026-07-10", "2026-07-12", 2);
      mockFindUnique.mockResolvedValue(booking);

      await sendBumpedNotifications(["b1"]);

      expect(sendBookingBumpedEmail).toHaveBeenCalledWith(
        "b1@example.com",
        "Test",
        booking.checkIn,
        booking.checkOut,
        2
      );
    });

    it("continues sending even if one email fails", async () => {
      const booking1 = makeBooking("b1", "2026-07-10", "2026-07-12", 2);
      const booking2 = makeBooking("b2", "2026-07-13", "2026-07-15", 3);

      mockFindUnique
        .mockResolvedValueOnce(booking1)
        .mockResolvedValueOnce(booking2);

      vi.mocked(sendBookingBumpedEmail)
        .mockRejectedValueOnce(new Error("SMTP error"))
        .mockResolvedValueOnce(undefined);

      await sendBumpedNotifications(["b1", "b2"]);

      expect(sendBookingBumpedEmail).toHaveBeenCalledTimes(2);
    });

    it("skips bookings that are not found", async () => {
      mockFindUnique.mockResolvedValue(null);

      await sendBumpedNotifications(["nonexistent"]);

      expect(sendBookingBumpedEmail).not.toHaveBeenCalled();
    });
  });

  describe("sendPartialBumpNotifications", () => {
    it("emails the guests-removed notice with the repriced total", async () => {
      mockFindUnique.mockResolvedValue({
        id: "bk1",
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
        finalPriceCents: 8000,
        member: { email: "m@example.com", firstName: "Pat" },
        guests: [{ id: "g1" }],
      });

      await sendPartialBumpNotifications(["bk1"]);

      expect(sendBookingGuestsRemovedEmail).toHaveBeenCalledWith(
        "m@example.com",
        "Pat",
        expect.any(Date),
        expect.any(Date),
        1,
        8000
      );
    });
  });
});
